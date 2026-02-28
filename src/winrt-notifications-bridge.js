import net from 'node:net';

const REQUEST_TIMEOUT_MS = 7000;
const BACKOFF_MIN_MS = 500;
const BACKOFF_MAX_MS = 15000;

function resolveDaemonHost() {
  const configured = (process.env.WINRT_NOTIFICATIONS_DAEMON_HOST ?? '').trim();
  return configured || '127.0.0.1';
}

function resolveDaemonPort() {
  const configured = Number.parseInt((process.env.WINRT_NOTIFICATIONS_DAEMON_PORT ?? '').trim(), 10);
  if (Number.isFinite(configured) && configured > 0 && configured < 65536) {
    return configured;
  }

  return 8765;
}

function normalizeBridgeResponse(payload) {
  return {
    ok: Boolean(payload?.ok),
    errorCode: typeof payload?.errorCode === 'string' ? payload.errorCode : null,
    message: typeof payload?.message === 'string' ? payload.message : null,
    notifications: Array.isArray(payload?.notifications) ? payload.notifications : []
  };
}

class WinRtDaemonClient {
  constructor() {
    this.host = resolveDaemonHost();
    this.port = resolveDaemonPort();
    this.socket = null;
    this.buffer = '';
    this.connectPromise = null;
    this.connected = false;
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
    this.requestCounter = 0;
    this.pendingRequests = new Map();
    this.eventListeners = new Set();
    this.connectionStateListeners = new Set();
  }

  async checkAvailability() {
    try {
      const response = await this.sendRequest({ type: 'ping' });
      return {
        available: Boolean(response?.ok),
        helperPath: `${this.host}:${this.port}`,
        reason: response?.ok ? null : response?.message ?? 'Daemon ping failed.'
      };
    } catch (error) {
      return {
        available: false,
        helperPath: `${this.host}:${this.port}`,
        reason: `Unable to connect to daemon at ${this.host}:${this.port} (${error.message}).`
      };
    }
  }

  async readNotifications() {
    try {
      const response = await this.sendRequest({ type: 'read_notifications' });
      return normalizeBridgeResponse(response);
    } catch (error) {
      const unavailableErrorCodes = new Set(['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH']);
      const errorCode = error.code === 'EACCES' || error.code === 'EPERM'
        ? 'ACCESS_DENIED'
        : unavailableErrorCodes.has(error.code)
          ? 'API_UNAVAILABLE'
          : 'READ_FAILED';

      return {
        ok: false,
        errorCode,
        message: `Failed to read notifications from daemon: ${error.message}`,
        notifications: []
      };
    }
  }

  async startNotificationPush() {
    try {
      const response = await this.sendRequest({ type: 'subscribe_notifications' });
      return {
        ok: Boolean(response?.ok),
        message: response?.message ?? null
      };
    } catch (error) {
      return {
        ok: false,
        message: error.message
      };
    }
  }

  onEvent(listener) {
    if (typeof listener !== 'function') {
      return () => {};
    }

    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  onConnectionState(listener) {
    if (typeof listener !== 'function') {
      return () => {};
    }

    this.connectionStateListeners.add(listener);
    return () => {
      this.connectionStateListeners.delete(listener);
    };
  }

  async sendRequest(payload) {
    await this.ensureConnected();

    const id = `req-${Date.now()}-${++this.requestCounter}`;
    const message = JSON.stringify({ ...payload, id });

    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Timed out waiting for daemon response (${REQUEST_TIMEOUT_MS} ms).`));
      }, REQUEST_TIMEOUT_MS);

      this.pendingRequests.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        }
      });

      this.socket.write(`${message}\n`, (error) => {
        if (!error) return;
        const pending = this.pendingRequests.get(id);
        if (!pending) return;
        this.pendingRequests.delete(id);
        pending.reject(error);
      });
    });
  }

  async ensureConnected() {
    if (this.connected && this.socket && !this.socket.destroyed) {
      return;
    }

    if (!this.connectPromise) {
      this.connectPromise = this.connect();
    }

    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  async connect() {
    const delayMs = this.reconnectAttempt === 0
      ? 0
      : Math.min(BACKOFF_MIN_MS * 2 ** (this.reconnectAttempt - 1), BACKOFF_MAX_MS);

    if (delayMs > 0) {
      await new Promise((resolve) => {
        this.reconnectTimer = setTimeout(resolve, delayMs);
      });
    }

    await new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port });

      const handleError = (error) => {
        socket.removeAllListeners();
        socket.destroy();
        this.connected = false;
        this.reconnectAttempt += 1;
        reject(error);
      };

      socket.once('error', handleError);
      socket.once('connect', () => {
        socket.removeListener('error', handleError);

        this.socket = socket;
        this.buffer = '';
        this.connected = true;
        this.reconnectAttempt = 0;
        this.emitConnectionState({ connected: true });

        socket.on('data', (chunk) => this.handleData(chunk));
        socket.on('error', (error) => this.handleDisconnect(error));
        socket.on('close', () => this.handleDisconnect());
        resolve();
      });
    });
  }

  handleData(chunk) {
    this.buffer += String(chunk);

    while (true) {
      const newlineIndex = this.buffer.indexOf('\n');
      if (newlineIndex === -1) {
        break;
      }

      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (!line) continue;

      try {
        const payload = JSON.parse(line);
        const requestId = payload?.id;
        if (requestId) {
          const pending = this.pendingRequests.get(requestId);
          if (!pending) continue;
          this.pendingRequests.delete(requestId);
          pending.resolve(payload);
          continue;
        }

        this.emitEvent(payload);
      } catch {
        // Ignore malformed daemon line and continue parsing next payload.
      }
    }
  }

  handleDisconnect(error) {
    if (!this.connected && (!this.socket || this.socket.destroyed)) {
      return;
    }

    this.connected = false;
    this.emitConnectionState({ connected: false, error });

    if (this.socket && !this.socket.destroyed) {
      this.socket.destroy();
    }

    this.socket = null;

    for (const [requestId, pending] of this.pendingRequests.entries()) {
      this.pendingRequests.delete(requestId);
      pending.reject(error ?? new Error('Daemon connection closed.'));
    }
  }

  emitEvent(payload) {
    for (const listener of this.eventListeners) {
      try {
        listener(payload);
      } catch {
        // Ignore listener errors to keep bridge event flow alive.
      }
    }
  }

  emitConnectionState(payload) {
    for (const listener of this.connectionStateListeners) {
      try {
        listener(payload);
      } catch {
        // Ignore listener errors to keep bridge connection flow alive.
      }
    }
  }
}

const daemonClient = new WinRtDaemonClient();

export async function checkWinRtBridgeAvailability() {
  return await daemonClient.checkAvailability();
}

export async function readWinRtNotificationsFromBridge() {
  return await daemonClient.readNotifications();
}

export async function startWinRtNotificationPush() {
  return await daemonClient.startNotificationPush();
}

export function onWinRtBridgeEvent(listener) {
  return daemonClient.onEvent(listener);
}

export function onWinRtBridgeConnectionState(listener) {
  return daemonClient.onConnectionState(listener);
}

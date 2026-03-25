import { ComponentType, MessageFlags, SeparatorSpacingSize } from 'discord-api-types/v10';

function assertNoEmbeds(payload) {
  if (!payload || typeof payload !== 'object') {
    return;
  }

  if (Array.isArray(payload.embeds) && payload.embeds.length > 0) {
    throw new Error('Embeds are not allowed. Use Discord Components V2 builders from src/components-v2.js.');
  }
}

export function buildV2Container(components) {
  return {
    type: ComponentType.Container,
    components: Array.isArray(components) ? components : []
  };
}

export function buildV2TextDisplay(content) {
  return {
    type: ComponentType.TextDisplay,
    content: String(content ?? '')
  };
}

export function buildV2Separator({ divider = true, spacing = SeparatorSpacingSize.Small } = {}) {
  return {
    type: ComponentType.Separator,
    divider,
    spacing
  };
}

export function buildV2ActionRow(components) {
  return {
    type: ComponentType.ActionRow,
    components: Array.isArray(components) ? components : []
  };
}

export function buildV2TextMessageComponents(content) {
  return [
    buildV2Container([
      buildV2TextDisplay(content)
    ])
  ];
}

export function buildV2MessagePayload({ components, flags = MessageFlags.IsComponentsV2, ...rest } = {}) {
  assertNoEmbeds(rest);
  return {
    ...rest,
    components,
    flags
  };
}

export function assertComponentsV2Payload(payload) {
  assertNoEmbeds(payload);
  return payload;
}

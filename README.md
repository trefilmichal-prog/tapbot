# Discord.js starter (VS Code)

Tenhle projekt je minimální "slash-command" bot (*/ping*), připravený pro práci ve VS Code.

## Požadavky
- Node.js **22.12.0+** (dle oficiální dokumentace discord.js). 

Ověření verze:
- `node -v`

## Rychlý start
1) Otevři složku projektu ve VS Code.
2) V integrovaném terminálu:
- `npm install`
- `npm run setup`
- `npm run deploy`
- `npm start`

## Spuštění bota (Windows vs. ostatní OS)
- **Windows:** Použij `run.bat` (startuje bota a uloží PID do `data/bot.pid`).
- **macOS/Linux/WSL:** Použij `run.ps1` v PowerShellu (`pwsh`).

### Co dělá `setup`
Interaktivně se zeptá na:
- **Bot token**
- **Client ID** (Application ID)
- volitelně **Guild ID** (pro rychlé registrování příkazů jen do serveru)

Uloží to do `config.json` (soubor je v `.gitignore`).

## Kde vzít údaje
V Discord Developer Portal:
- Application ID = **Client ID**
- Token = **Bot** → Reset Token / Copy
- Guild ID = ID tvého serveru (zapni Developer Mode v Discordu → pravým na server → Copy ID)

## Poznámky
- Pokud vyplníš Guild ID, příkazy se zaregistrují okamžitě jen pro tento server.
- Pokud Guild ID necháš prázdné, příkazy se registrují globálně (může to trvat déle, podle Discordu).

## Aktualizace na Windows
1) Ujisti se, že máš nainstalovaný PowerShell (součást Windows).
2) Spusť `update.bat` v kořeni repozitáře.

Skript stáhne poslední verzi z GitHubu, aktualizuje soubory a zachová `config.json` i složku `data/`, poté bota znovu spustí pomocí `run.bat`.

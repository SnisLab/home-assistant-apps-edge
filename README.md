# SnisLab Home Assistant Apps Edge

Dieses Repository ist der öffentliche Edge-Katalog für die Home Assistant Apps
von SnisLab. Die App-Verzeichnisse werden automatisch erzeugt und dürfen nicht
direkt bearbeitet werden.

## Repository In Home Assistant Hinzufügen

1. **Einstellungen > Apps > App Store** öffnen.
2. Die Verwaltung der Repositories öffnen.
3. `https://github.com/SnisLab/home-assistant-apps-edge` hinzufügen.

Der Edge-Kanal ist für das Testen automatischer Builds gedacht. Für stabile
Versionen bleibt `home-assistant-apps` zuständig.

## Architektur

Die Verantwortlichkeiten bleiben getrennt:

```text
SnisLab/<projekt>
  -> Edge-Build und ghcr.io/snislab/<projekt>:edge
  -> SnisLab/app-<projekt>
  -> SnisLab/home-assistant-apps-edge/<projekt>
```

Das Hauptprojekt enthält die Anwendung. `app-<projekt>` enthält ausschließlich
das Home-Assistant-spezifische Packaging und verwendet das veröffentlichte
Image oder Release des Hauptprojekts. Dieses Repository dient nur der
Distribution.

## Aufbau Eines App-Repositories

Die Home-Assistant-Dateien liegen direkt im Root des jeweiligen
`app-<projekt>`-Repositories:

```text
app-example/
|-- config.yaml
|-- Dockerfile
|-- run.sh
|-- README.md
|-- DOCS.md
|-- CHANGELOG.md
|-- icon.png
|-- logo.png
`-- translations/
```

Die Anwendung selbst wird dort nicht dupliziert. Bei einem bereits gebauten
Container verweist `config.yaml` auf GHCR:

```yaml
name: "Example App"
version: "1.0.0"
slug: "snislab_example"
description: "Short description of the app"
arch:
  - aarch64
  - amd64
image: "ghcr.io/snislab/example"
```

Der Katalog kopiert `app-example` automatisch nach `example/`. Home Assistant
findet die dort enthaltene `config.yaml` als eigenständige App.

## Automatische Synchronisierung

Der Workflow `.github/workflows/sync-apps.yml` akzeptiert ausschließlich
`repository_dispatch`-Events mit `tag: "edge"`. Dadurch können automatische
Builds getestet werden, ohne den stabilen Katalog zu verändern.

Der Dispatch muss diese Daten enthalten:

```json
{
  "event_type": "app-released",
  "client_payload": {
    "repository": "app-example",
    "version": "1.0.0",
    "tag": "edge",
    "sha": "0123456789abcdef0123456789abcdef01234567",
    "image": "ghcr.io/snislab/example:edge"
  }
}
```

Das App-Repository muss dafür einen `edge`-Ref besitzen. Der SHA muss auf
diesen Ref zeigen:

```json
{
  "repository": "app-example",
  "version": "1.0.0",
  "tag": "edge",
  "sha": "0123456789abcdef0123456789abcdef01234567",
  "image": "ghcr.io/snislab/example:edge"
}
```

Ein Release-Workflow im `app-*`-Repository kann den Katalog so auslösen:

```yaml
- name: Home Assistant Katalog aktualisieren
  env:
    GH_TOKEN: ${{ secrets.HOME_ASSISTANT_APPS_TOKEN }}
    VERSION: ${{ steps.release.outputs.version }}
    IMAGE: ${{ steps.release.outputs.image }}
  run: |
    gh api --method POST repos/SnisLab/home-assistant-apps-edge/dispatches --input - <<JSON
    {
      "event_type": "app-released",
      "client_payload": {
        "repository": "${{ github.event.repository.name }}",
        "version": "${VERSION}",
        "tag": "edge",
        "sha": "${{ github.sha }}",
        "image": "${IMAGE}"
      }
    }
    JSON
```

Für private Quell-Repositories wird im Katalog das Secret
`ORG_REPOSITORY_TOKEN` benötigt. Es soll als Fine-Grained PAT ausschließlich
Leserechte auf Metadaten und Inhalte der benötigten `app-*`-Repositories
erhalten. Das Dispatch-Token erhält nur Schreibzugriff auf dieses Katalog-Repo.

## Lokale Prüfung

```shell
npm ci
npm test
```

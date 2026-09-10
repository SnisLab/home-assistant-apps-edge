# Changelog

## 0.4.0

- Split Home Assistant packaging from the Pulse2MQTT application repository.
- Consume the versioned application image from GHCR.
- Add selectable AA battery profiles and an estimated battery entity.

## Initial release

- Package Pulse2MQTT as a Home Assistant app.
- Detect the Home Assistant MQTT service automatically.
- Support external MQTT brokers as an alternative.
- Register energy, power and diagnostic entities through MQTT Discovery.

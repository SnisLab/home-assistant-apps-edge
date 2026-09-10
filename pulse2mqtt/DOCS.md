# Pulse2MQTT

Pulse2MQTT reads local meter data from a Tibber Pulse and publishes the values to MQTT. Home Assistant MQTT Discovery creates one device with energy, power and diagnostic entities automatically.

## Prerequisites

The MQTT integration must be configured in Home Assistant. The official Mosquitto Broker app is detected automatically. An external MQTT broker can be configured with the optional `mqtt_*` settings.

## Configuration

- `pulse_host`: Hostname or IP address of the Tibber Pulse.
- `pulse_username`: HTTP username of the Tibber Pulse.
- `pulse_password`: HTTP password of the Tibber Pulse.
- `pulse_node`: Pulse node ID, normally `1`.
- `battery_profile`: Voltage curve used for the two installed AA cells. See Battery Level below.
- `data_topic`: MQTT topic for energy and power readings.
- `metrics_topic`: MQTT topic for diagnostic readings.
- `discovery_prefix`: Home Assistant MQTT Discovery prefix, normally `homeassistant`.
- `device_id`: Stable identifier used for the Home Assistant device and entities. Do not change it after setup.
- `device_name`: Device name shown in Home Assistant.
- `mqtt_host`: Optional external MQTT broker. If omitted, the Home Assistant MQTT service is used.
- `mqtt_port`: Port of the optional external MQTT broker, normally `1883`.
- `mqtt_username`: Username of the optional external MQTT broker.
- `mqtt_password`: Password of the optional external MQTT broker.

## Energy Dashboard

The energy consumption and feed-in entities use the `energy` device class and `total_increasing` state class. They can be selected directly in the Home Assistant Energy Dashboard after the first readings have arrived.

## Battery Level

The Pulse exposes the combined battery voltage but no charge percentage. Choose the profile matching the two installed AA cells:

- `alkaline`: regular 1.5 V alkaline cells, estimated from 2.0 V (0%) to 3.2 V (100%).
- `lfb_aa`: LFB 1.5 V AA cells, estimated from the observed 2.7 V (0%) to 3.2 V (100%).
- `nimh_1_2v`: rechargeable 1.2 V NiMH cells, estimated from 2.0 V (0%) to 2.8 V (100%).
- `regulated_1_5v`: rechargeable cells with regulated 1.5 V output. Reports 80% at 2.8 V or above and 0% below 2.8 V.

The first three profiles are rough linear estimates limited to 0-100%. The regulated profile is only a status indicator, not an actual charge measurement. If its internal regulator switches off abruptly, the Pulse might stop before it can publish the final 0% value. Battery load, temperature, age and manufacturer affect the actual discharge curve. The original voltage remains available as a disabled-by-default diagnostic entity for every profile.

## Existing MQTT Sensors

MQTT Discovery can create additional entities if the same topics are already configured manually. Remove or rename old manual MQTT sensors before enabling the app if duplicate entities are not wanted.

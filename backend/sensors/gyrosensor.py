"""MPU6050 gyroscope access over I2C.

Only the gyro rates are exposed. The sensor is configured for +/-500 deg/s by
default, with the on-chip DLPF set to a 42 Hz gyro bandwidth.
"""

import logging
import threading
import time

import config

logger = logging.getLogger(__name__)

_GYRO_RANGES = {
    250: (0x00, 131.0),
    500: (0x08, 65.5),
    1000: (0x10, 32.8),
    2000: (0x18, 16.4),
}

# MPU6050 plus a few common clones.
_WHO_AM_I_VALUES = {0x68, 0x70, 0x98}

_REG_WHO_AM_I = 0x75
_REG_PWR_MGMT_1 = 0x6B
_REG_CONFIG = 0x1A
_REG_SMPLRT_DIV = 0x19
_REG_GYRO_CONFIG = 0x1B
_REG_GYRO_XOUT_H = 0x43

_lock = threading.Lock()
_bus = None
_sensitivity = None
_offset_x = 0.0
_offset_y = 0.0
_offset_z = 0.0
_last_error_log = 0.0


def init():
    """Open the I2C bus and configure the MPU6050."""
    global _bus, _sensitivity, _offset_x, _offset_y, _offset_z

    if _bus is not None:
        return

    from smbus2 import SMBus

    bus = None
    try:
        bus = SMBus(config.GYRO_I2C_BUS)
        who_am_i = bus.read_byte_data(config.GYRO_I2C_ADDRESS, _REG_WHO_AM_I)
        if who_am_i not in _WHO_AM_I_VALUES:
            raise RuntimeError(
                f"unexpected WHO_AM_I 0x{who_am_i:02X} at "
                f"0x{config.GYRO_I2C_ADDRESS:02X} on I2C bus "
                f"{config.GYRO_I2C_BUS}"
            )

        # Wake the device and use the X-axis gyro PLL as the clock source.
        bus.write_byte_data(config.GYRO_I2C_ADDRESS, _REG_PWR_MGMT_1, 0x01)
        time.sleep(0.05)

        # DLPF_CFG=3 gives ~42 Hz gyro bandwidth, plenty for 20 Hz polling.
        bus.write_byte_data(config.GYRO_I2C_ADDRESS, _REG_CONFIG, 0x03)
        # 1 kHz / (1 + 4) = 200 Hz sample rate.
        bus.write_byte_data(config.GYRO_I2C_ADDRESS, _REG_SMPLRT_DIV, 0x04)

        gyro_config, sensitivity = _GYRO_RANGES[config.GYRO_RANGE_DPS]
        bus.write_byte_data(
            config.GYRO_I2C_ADDRESS, _REG_GYRO_CONFIG, gyro_config
        )
        time.sleep(0.05)
    except Exception as exc:
        if bus is not None:
            try:
                bus.close()
            except Exception:
                pass
        raise RuntimeError(
            "Could not initialise the MPU6050. Check the wiring, I2C address, "
            "and that I2C is enabled."
        ) from exc

    with _lock:
        _bus = bus
        _sensitivity = sensitivity
        _offset_x = 0.0
        _offset_y = 0.0
        _offset_z = 0.0

    logger.info(
        "MPU6050 ready: I2C bus %d, address 0x%02X, range +/-%d deg/s",
        config.GYRO_I2C_BUS,
        config.GYRO_I2C_ADDRESS,
        config.GYRO_RANGE_DPS,
    )

    if config.GYRO_CALIBRATE:
        try:
            _calibrate()
        except Exception as exc:
            _close_bus()
            raise RuntimeError(
                "Could not read the MPU6050 during calibration. Check the "
                "wiring and I2C connection, or set GYRO_CALIBRATE=0 to skip "
                "calibration."
            ) from exc


def cleanup():
    """Close the I2C bus."""
    _close_bus()
    logger.info("MPU6050 released")


def read():
    """Return {'gyro': {'x': ..., 'y': ..., 'z': ...}}."""
    values = read_gyro_dps()
    logger.debug(
        "gyro x=%.2f y=%.2f z=%.2f deg/s",
        values["x"],
        values["y"],
        values["z"],
    )
    return {"gyro": values}


def read_gyro_dps():
    """Return bias-corrected angular rates in degrees per second."""
    with _lock:
        if _bus is None or _sensitivity is None:
            raise RuntimeError("MPU6050 has not been initialised")

        try:
            data = _bus.read_i2c_block_data(
                config.GYRO_I2C_ADDRESS, _REG_GYRO_XOUT_H, 6
            )
            x = _to_signed16(data[0], data[1]) - _offset_x
            y = _to_signed16(data[2], data[3]) - _offset_y
            z = _to_signed16(data[4], data[5]) - _offset_z
            sensitivity = _sensitivity
        except Exception:
            _log_read_error()
            return {"x": 0.0, "y": 0.0, "z": 0.0}

    return {
        "x": round(x / sensitivity, 2),
        "y": round(y / sensitivity, 2),
        "z": round(z / sensitivity, 2),
    }


def _calibrate():
    global _offset_x, _offset_y, _offset_z

    samples = config.GYRO_CALIBRATION_SAMPLES
    logger.info("Calibrating MPU6050; keep it still (%d samples)", samples)

    total_x = 0.0
    total_y = 0.0
    total_z = 0.0
    for _ in range(samples):
        x, y, z = _read_raw_gyro()
        total_x += x
        total_y += y
        total_z += z
        time.sleep(0.005)

    with _lock:
        _offset_x = total_x / samples
        _offset_y = total_y / samples
        _offset_z = total_z / samples

    logger.info("MPU6050 calibration done")


def _read_raw_gyro():
    with _lock:
        if _bus is None:
            raise RuntimeError("MPU6050 has not been initialised")

        data = _bus.read_i2c_block_data(
            config.GYRO_I2C_ADDRESS, _REG_GYRO_XOUT_H, 6
        )
        return (
            _to_signed16(data[0], data[1]),
            _to_signed16(data[2], data[3]),
            _to_signed16(data[4], data[5]),
        )


def _to_signed16(high, low):
    value = (high << 8) | low
    if value >= 0x8000:
        value -= 0x10000
    return value


def _close_bus():
    global _bus

    with _lock:
        bus = _bus
        _bus = None

    if bus is not None:
        try:
            bus.close()
        except Exception:
            logger.exception("Failed to close the MPU6050 I2C bus")


def _log_read_error():
    global _last_error_log

    now = time.monotonic()
    if now - _last_error_log >= 1.0:
        logger.exception("MPU6050 read failed; reporting zero rates")
        _last_error_log = now

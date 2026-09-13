package com.omnitrace.android.host

import java.io.File
import java.io.FileOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.Calendar

/**
 * IMU 物理流 `imu_DD.bin`，大端。
 *
 * Header 16B: magic `OTIM`, u8 ver=1, u8 pad, u16 pad, u64 epoch_ms
 * Record:
 *   0xFF 绝对：u64 ts, u8 ch, i16 x, i16 y, i16 z
 *   1..250 相对：该字节=dt_ms, u8 ch, i8 dx, i8 dy, i8 dz
 *
 * 通道：1 accel, 2 linear, 3 gyro, 4 mag。
 * 量化：accel/linear = m/s²×1000；gyro = rad/s×1000；mag = µT×10。
 */
class ImuBinWriter(private val root: File) {
    companion object {
        const val CH_ACCEL: Int = 1
        const val CH_LINEAR: Int = 2
        const val CH_GYRO: Int = 3
        const val CH_MAG: Int = 4
    }

    private val lock = Any()
    private var day = -1
    private var out: FileOutputStream? = null
    private val lastTs = LongArray(5) { -1L }
    private val lastX = ShortArray(5)
    private val lastY = ShortArray(5)
    private val lastZ = ShortArray(5)

    fun write(channel: Int, ts: Long, x: Float, y: Float, z: Float) {
        val qx: Short
        val qy: Short
        val qz: Short
        when (channel) {
            CH_MAG -> {
                qx = q(x * 10f)
                qy = q(y * 10f)
                qz = q(z * 10f)
            }
            else -> {
                qx = q(x * 1000f)
                qy = q(y * 1000f)
                qz = q(z * 1000f)
            }
        }
        synchronized(lock) {
            roll(ts)
            val stream = out ?: return
            val prevTs = lastTs[channel]
            val dt = if (prevTs < 0) Long.MAX_VALUE else ts - prevTs
            val dx = qx - lastX[channel]
            val dy = qy - lastY[channel]
            val dz = qz - lastZ[channel]
            val rel = prevTs >= 0 &&
                dt in 1..250 &&
                dx in -128..127 &&
                dy in -128..127 &&
                dz in -128..127
            if (rel) {
                val buf = ByteBuffer.allocate(5).order(ByteOrder.BIG_ENDIAN)
                buf.put(dt.toByte())
                buf.put(channel.toByte())
                buf.put(dx.toByte())
                buf.put(dy.toByte())
                buf.put(dz.toByte())
                stream.write(buf.array())
            } else {
                val buf = ByteBuffer.allocate(16).order(ByteOrder.BIG_ENDIAN)
                buf.put(0xFF.toByte())
                buf.putLong(ts)
                buf.put(channel.toByte())
                buf.putShort(qx)
                buf.putShort(qy)
                buf.putShort(qz)
                stream.write(buf.array())
            }
            lastTs[channel] = ts
            lastX[channel] = qx
            lastY[channel] = qy
            lastZ[channel] = qz
        }
    }

    fun flush() {
        synchronized(lock) { out?.flush() }
    }

    fun close() {
        synchronized(lock) {
            try {
                out?.flush()
                out?.close()
            } catch (_: Exception) {
            }
            out = null
        }
    }

    private fun roll(ts: Long) {
        val cal = Calendar.getInstance()
        cal.timeInMillis = ts
        val d = OmniPaths.day(cal)
        if (d == day && out != null) return
        out?.flush()
        out?.close()
        val f = OmniPaths.imuBinToday(root, cal)
        val exists = f.exists() && f.length() > 0
        out = FileOutputStream(f, true)
        if (!exists) {
            val hdr = ByteBuffer.allocate(16).order(ByteOrder.BIG_ENDIAN)
            hdr.put('O'.code.toByte())
            hdr.put('T'.code.toByte())
            hdr.put('I'.code.toByte())
            hdr.put('M'.code.toByte())
            hdr.put(1)
            hdr.put(0)
            hdr.putShort(0)
            hdr.putLong(ts)
            out!!.write(hdr.array())
        }
        day = d
        for (i in lastTs.indices) lastTs[i] = -1L
    }

    private fun q(v: Float): Short {
        val n = v.toInt().coerceIn(Short.MIN_VALUE.toInt(), Short.MAX_VALUE.toInt())
        return n.toShort()
    }
}

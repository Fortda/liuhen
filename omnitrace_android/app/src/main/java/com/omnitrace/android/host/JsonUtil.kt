package com.omnitrace.android.host

import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest
import java.util.TreeMap

object JsonUtil {
    fun nowMs(): Long = System.currentTimeMillis()

    fun sha256Hex(s: String): String {
        val d = MessageDigest.getInstance("SHA-256").digest(s.toByteArray(Charsets.UTF_8))
        return d.joinToString("") { b -> "%02x".format(b) }
    }

    fun canonical(value: Any?): String = writeCanonical(value)

    private fun writeCanonical(value: Any?): String {
        return when (value) {
            null, JSONObject.NULL -> "null"
            is JSONObject -> {
                val keys = value.keys().asSequence().toList().sorted()
                val inner = keys.joinToString(",") { k ->
                    JSONObject.quote(k) + ":" + writeCanonical(value.opt(k))
                }
                "{$inner}"
            }
            is JSONArray -> {
                val inner = (0 until value.length()).joinToString(",") { i ->
                    writeCanonical(value.opt(i))
                }
                "[$inner]"
            }
            is Number -> {
                if (value is Double || value is Float) {
                    val d = value.toDouble()
                    if (d == d.toLong().toDouble()) d.toLong().toString() else d.toString()
                } else value.toString()
            }
            is Boolean -> value.toString()
            is String -> JSONObject.quote(value)
            else -> JSONObject.quote(value.toString())
        }
    }

    fun sortedCopy(obj: JSONObject): JSONObject {
        val out = JSONObject()
        TreeMap<String, Any?>().also { map ->
            obj.keys().forEach { k -> map[k] = obj.opt(k) }
        }.forEach { (k, v) -> out.put(k, v) }
        return out
    }

    fun topLevelDiff(prev: JSONObject?, next: JSONObject): JSONObject {
        val diff = JSONObject()
        val keys = mutableSetOf<String>()
        prev?.keys()?.forEach { keys.add(it) }
        next.keys().forEach { keys.add(it) }
        for (k in keys.sorted()) {
            val a = prev?.opt(k)
            val b = next.opt(k)
            if (canonical(a) != canonical(b)) {
                diff.put(k, json("prev" to (a ?: JSONObject.NULL), "next" to (b ?: JSONObject.NULL)))
            }
        }
        return diff
    }
}

/** 避开 org.json 在 Kotlin 2 上 Boolean/Int 重载歧义。 */
fun json(vararg pairs: Pair<String, Any?>): JSONObject {
    val o = JSONObject()
    for ((k, v) in pairs) {
        o.kv(k, v)
    }
    return o
}

fun JSONObject.kv(key: String, value: Any?): JSONObject {
    val boxed: Any = value ?: JSONObject.NULL
    put(key, boxed)
    return this
}

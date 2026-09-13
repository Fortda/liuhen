package com.omnitrace.android.ui

import android.content.Context
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.TextView
import com.google.android.material.button.MaterialButton
import com.google.android.material.switchmaterial.SwitchMaterial
import com.omnitrace.android.R

object SettingsUi {
    fun dp(ctx: Context, n: Int): Int =
        (n * ctx.resources.displayMetrics.density).toInt()

    fun hairline(ctx: Context): View {
        val v = View(ctx)
        v.setBackgroundColor(ctx.getColor(R.color.line))
        val h = dp(ctx, 1).coerceAtLeast(1)
        v.layoutParams = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, h)
        return v
    }

    fun row(parent: ViewGroup, label: String): Pair<TextView, LinearLayout> {
        if (parent.childCount > 0) parent.addView(hairline(parent.context))
        val row = LayoutInflater.from(parent.context)
            .inflate(R.layout.item_setting_row, parent, false) as LinearLayout
        val txt = row.findViewById<TextView>(R.id.txtLabel)
        val box = row.findViewById<LinearLayout>(R.id.boxActions)
        txt.text = label
        parent.addView(row)
        return txt to box
    }

    fun action(ctx: Context, text: String, onClick: View.OnClickListener): MaterialButton {
        val b = MaterialButton(ctx, null, com.google.android.material.R.attr.materialButtonOutlinedStyle)
        b.text = text
        b.textSize = 13f
        b.minHeight = dp(ctx, 36)
        b.minimumHeight = dp(ctx, 36)
        b.minWidth = 0
        b.minimumWidth = 0
        b.insetTop = 0
        b.insetBottom = 0
        val pad = dp(ctx, 12)
        b.setPadding(pad, 0, pad, 0)
        val lp = LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT,
            LinearLayout.LayoutParams.WRAP_CONTENT,
        )
        lp.marginStart = dp(ctx, 6)
        b.layoutParams = lp
        b.setOnClickListener(onClick)
        return b
    }

    fun endSwitch(ctx: Context): SwitchMaterial {
        val s = SwitchMaterial(ctx)
        s.text = ""
        s.minWidth = 0
        val lp = LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT,
            LinearLayout.LayoutParams.WRAP_CONTENT,
        )
        lp.marginStart = dp(ctx, 6)
        s.layoutParams = lp
        return s
    }

    fun value(ctx: Context, text: String): TextView {
        val t = TextView(ctx)
        t.text = text
        t.setTextColor(ctx.getColor(R.color.fg))
        t.textSize = 14f
        t.textAlignment = View.TEXT_ALIGNMENT_VIEW_END
        val lp = LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT,
            LinearLayout.LayoutParams.WRAP_CONTENT,
        )
        lp.marginStart = dp(ctx, 8)
        t.layoutParams = lp
        return t
    }

    fun bindExclusive(buttons: List<MaterialButton>, selected: Int, onPick: (Int) -> Unit) {
        fun paint(which: Int) {
            buttons.forEachIndexed { i, b -> b.isChecked = i == which }
        }
        buttons.forEachIndexed { i, b ->
            b.isCheckable = true
            b.setOnClickListener {
                paint(i)
                onPick(i)
            }
        }
        paint(selected)
    }
}

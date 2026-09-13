package com.omnitrace.android.ui

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import androidx.fragment.app.Fragment
import com.omnitrace.android.MainActivity
import com.omnitrace.android.R
import com.omnitrace.android.databinding.FragmentAboutSettingsBinding

class AboutSettingsFragment : Fragment() {
    private var binding: FragmentAboutSettingsBinding? = null

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        val b = FragmentAboutSettingsBinding.inflate(inflater, container, false)
        binding = b
        return b.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        val b = binding ?: return
        (activity as? MainActivity)?.fitScroll(b.root)
        b.head.txtSubTitle.text = getString(R.string.set_page_about)
        b.head.btnBack.setOnClickListener { parentFragmentManager.popBackStack() }
    }

    override fun onDestroyView() {
        binding = null
        super.onDestroyView()
    }
}

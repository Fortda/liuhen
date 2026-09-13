package com.omnitrace.android.ui

import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.fragment.app.Fragment
import com.omnitrace.android.MainActivity
import com.omnitrace.android.R
import com.omnitrace.android.databinding.FragmentCaptureGraphBinding
import com.omnitrace.android.graph.CaptureEduCatalog
import com.omnitrace.android.graph.CaptureGraphCatalog
import com.omnitrace.android.graph.HwSpecResolver

class CaptureGraphFragment : Fragment() {
    private var binding: FragmentCaptureGraphBinding? = null

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        val b = FragmentCaptureGraphBinding.inflate(inflater, container, false)
        binding = b
        return b.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        val b = binding ?: return
        b.head.txtSubTitle.text = getString(R.string.set_page_graph)
        b.head.btnBack.setOnClickListener { parentFragmentManager.popBackStack() }
        b.graph.onNodeClick = { node ->
            when (node.hwState) {
                CaptureGraphCatalog.HwState.MISSING -> {
                    Toast.makeText(requireContext(), R.string.graph_no_hw, Toast.LENGTH_SHORT).show()
                }
                CaptureGraphCatalog.HwState.NEED_PERM -> {
                    (activity as? MainActivity)?.openCaptureSettings()
                }
                CaptureGraphCatalog.HwState.OK -> {
                    if (node.kind == CaptureGraphCatalog.Kind.SOURCE) {
                        // 圆点：权限/缺失；详情点左侧名称
                    }
                }
            }
        }
        b.graph.onTitleClick = { node -> showEduDialog(node) }
        refreshGraph()
    }

    override fun onResume() {
        super.onResume()
        if (!isHidden) refreshGraph()
    }

    override fun onHiddenChanged(hidden: Boolean) {
        super.onHiddenChanged(hidden)
        if (!hidden && isResumed) refreshGraph()
    }

    private fun refreshGraph() {
        val b = binding ?: return
        b.graph.model = CaptureGraphCatalog.build(requireContext())
    }

    private fun showEduDialog(node: CaptureGraphCatalog.GraphNode) {
        val ctx = requireContext()
        val inv = HwSpecResolver.loadInventory(ctx)
        val edu = CaptureEduCatalog.detail(ctx, node.id, inv)
        AlertDialog.Builder(ctx)
            .setTitle(getString(R.string.graph_edu_title, edu.title))
            .setMessage(CaptureEduCatalog.formatMessage(edu))
            .setPositiveButton(android.R.string.ok, null)
            .show()
    }

    override fun onDestroyView() {
        binding = null
        super.onDestroyView()
    }
}

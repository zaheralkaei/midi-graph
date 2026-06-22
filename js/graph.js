// graph.js — D3 force-directed graph for the transition network.
//
// Public API:
//   MidiGraph.render(containerEl, graph)   — render the graph in the given container.
//                                             Returns a controller with:
//                                                update(graph)    re-render with new data
//                                                destroy()        tear down
//
// Internal: d3.forceSimulation with link distance 80, charge -250,
// center+collide, draggable nodes, zoom/pan on the SVG.
//
// The graph shape is { nodes: [{id}], links: [{source, target, value}] }
// produced by MidiGraph.buildTransitionGraph().

(function () {
  const M = window.MidiGraph;

  // 12 pitch classes, one color each. Sharp spelling (F# is index 6).
  const NOTE_NAMES = M.NOTE_NAMES;
  const pitchClassColor = d3.scaleOrdinal()
    .domain(NOTE_NAMES)
    .range(['#ff5252','#ff9d52','#ffd452','#52ff5d','#52ffd1','#52a8ff',
            '#9d52ff','#ff52d1','#ff5252','#ff9d52','#ffd452','#a8ff52']);

  // Parse a pitch-id like "F#5" or "C-1" back to a MIDI note number.
  // Used by the min/max pitch-range filter.
  function pitchOf(id) {
    const m = id.match(/^([A-G][#]?)(-?\d+)$/);
    if (!m) return 60;
    const pc = NOTE_NAMES.indexOf(m[1]);
    const octave = parseInt(m[2], 10);
    return (octave + 1) * 12 + pc;
  }

  function render(container, graph) {
    // Don't rely on clientWidth/clientHeight — if the container was display:none
    // when render() was called (the panel was just unhidden), those are 0 and
    // the SVG ends up width=0/height=0. CSS sets the container to 100% width
    // and a fixed height; we let the SVG fill that via width=100% / height=100%.
    const svg = d3.select(container).append('svg')
      .attr('width', '100%')
      .attr('height', '100%')
      .attr('viewBox', null);
    const g = svg.append('g');

    const zoom = d3.zoom()
      .scaleExtent([0.3, 8])
      .on('zoom', e => g.attr('transform', e.transform));
    svg.call(zoom);

    // Use the container's CSS-rendered size for the force center.
    // Read it on every tick so resize events don't leave the graph off-center.
    function getSize() {
      const r = container.getBoundingClientRect();
      return { w: Math.max(200, r.width), h: Math.max(200, r.height) };
    }

    const linkGroup = g.append('g').attr('class', 'links');
    const linkLabelGroup = g.append('g').attr('class', 'link-labels');
    const selfLoopLabelGroup = g.append('g').attr('class', 'self-loop-labels');
    const nodeGroup = g.append('g').attr('class', 'nodes');
    const labelGroup = g.append('g').attr('class', 'node-labels');

    // The raw graph is immutable from the caller's perspective. We mutate
    // working copies on filter changes so the source data stays clean.
    let workingNodes = graph.nodes.map(n => ({...n}));
    let workingLinks = graph.links.map(l => ({...l}));

    const { w: width, h: height } = getSize();
    let simulation = d3.forceSimulation()
      .force('link', d3.forceLink().id(d => d.id).distance(80))
      .force('charge', d3.forceManyBody().strength(-180))
      .force('center', d3.forceCenter(width / 2, height / 2))
      .force('collide', d3.forceCollide(28));

    function rebuild() {
      const minProb = +document.getElementById('min-prob').value / 100;
      const minPitch = +document.getElementById('min-pitch').value;
      const maxPitch = +document.getElementById('max-pitch').value;

      const filtered = workingLinks.filter(l => {
        const sp = pitchOf(l.source);
        const tp = pitchOf(l.target);
        return l.value >= minProb && sp >= minPitch && sp <= maxPitch && tp >= minPitch && tp <= maxPitch;
      });

      const presentNodeIds = new Set();
      filtered.forEach(l => {
        presentNodeIds.add(l.source);
        presentNodeIds.add(l.target);
      });
      const nodes = workingNodes.filter(n => presentNodeIds.has(n.id));
      const links = filtered.map(l => ({...l}));

      // ----- Links -----
      const linkSel = linkGroup.selectAll('path').data(links, d => d.source + '->' + d.target);
      linkSel.exit().remove();
      const linkEnter = linkSel.enter().append('path');
      const linkAll = linkEnter.merge(linkSel);

      // Self-loop labels (probability of A→A)
      const selfLoops = links.filter(d => d.source === d.target);
      const loopLabelSel = selfLoopLabelGroup.selectAll('text').data(selfLoops, d => d.source);
      loopLabelSel.exit().remove();
      loopLabelSel.enter().append('text')
        .attr('class', 'self-loop-label')
        .merge(loopLabelSel)
        .text(d => (d.value * 100).toFixed(0) + '%');

      // Other-edge labels
      const otherLinks = links.filter(d => d.source !== d.target);
      const linkLabelSel = linkLabelGroup.selectAll('text').data(otherLinks, d => d.source + '->' + d.target);
      linkLabelSel.exit().remove();
      linkLabelSel.enter().append('text')
        .attr('class', 'link-label')
        .attr('text-anchor', 'middle')
        .merge(linkLabelSel)
        .text(d => (d.value * 100).toFixed(0) + '%');

      // ----- Nodes -----
      const nodeSel = nodeGroup.selectAll('circle').data(nodes, d => d.id);
      nodeSel.exit().remove();
      const nodeEnter = nodeSel.enter().append('circle').attr('r', 18);
      const nodeAll = nodeEnter.merge(nodeSel)
        .call(d3.drag()
          .on('start', (e, d) => { if (!e.active) simulation.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
          .on('drag',  (e, d) => { d.fx = e.x; d.fy = e.y; })
          .on('end',   (e, d) => { if (!e.active) simulation.alphaTarget(0); d.fx = null; d.fy = null; }));

      const colorByClass = document.getElementById('color-by-pitch-class').checked;
      nodeAll.attr('fill', d => colorByClass ? pitchClassColor(M.pitchClass(pitchOf(d.id))) : '#00e5ff')
        .append('title').text(d => d.id);

      // ----- Node labels -----
      const labelSel = labelGroup.selectAll('text').data(nodes, d => d.id);
      labelSel.exit().remove();
      labelSel.enter().append('text')
        .attr('class', 'node-label')
        .attr('text-anchor', 'middle')
        .attr('dy', 4)
        .merge(labelSel)
        .text(d => d.id);

      // ----- Tick -----
      simulation.nodes(nodes);
      simulation.force('link').links(links);
      simulation.alpha(0.9).restart();

      simulation.on('tick', () => {
        const thicknessOn = document.getElementById('edge-thickness-by-prob').checked;
        // Re-center on every tick so window resizes don't leave the graph off-screen.
        const { w, h } = getSize();
        simulation.force('center').x(w / 2).y(h / 2);
        linkAll
          .attr('d', d => {
            if (d.source === d.target) {
              const x = d.source.x, y = d.source.y;
              return `M${x-8},${y-8} A14,14 0 1,1 ${x+8},${y-8}`;
            }
            const dx = d.target.x - d.source.x, dy = d.target.y - d.source.y;
            const dr = Math.sqrt(dx*dx + dy*dy);
            return `M${d.source.x},${d.source.y}A${dr},${dr} 0 0,1 ${d.target.x},${d.target.y}`;
          })
          .attr('stroke', '#666')
          .attr('stroke-opacity', 0.55)
          .attr('fill', 'none')
          .attr('stroke-width', d => thicknessOn ? 0.5 + d.value * 5 : 1.5);

        selfLoopLabelGroup.selectAll('text')
          .attr('x', d => d.source.x)
          .attr('y', d => d.source.y - 22);

        linkLabelGroup.selectAll('text')
          .attr('x', d => (d.source.x + d.target.x) / 2)
          .attr('y', d => (d.source.y + d.target.y) / 2 - 4);

        nodeAll.attr('cx', d => d.x).attr('cy', d => d.y);
        labelSel.attr('x', d => d.x).attr('y', d => d.y);
      });
    }

    rebuild();

    // Filter control listeners.
    const probInput = document.getElementById('min-prob');
    const minPitchInput = document.getElementById('min-pitch');
    const maxPitchInput = document.getElementById('max-pitch');
    const colorToggle = document.getElementById('color-by-pitch-class');
    const thicknessToggle = document.getElementById('edge-thickness-by-prob');

    probInput.addEventListener('input', e => {
      document.getElementById('min-prob-val').textContent = e.target.value + '%';
      rebuild();
    });
    minPitchInput.addEventListener('input', e => {
      document.getElementById('min-pitch-val').textContent = M.midiToPitch(+e.target.value);
      rebuild();
    });
    maxPitchInput.addEventListener('input', e => {
      document.getElementById('max-pitch-val').textContent = M.midiToPitch(+e.target.value);
      rebuild();
    });
    colorToggle.addEventListener('change', rebuild);
    thicknessToggle.addEventListener('change', rebuild);

    // Zoom buttons.
    document.getElementById('zoom-in').onclick  = () => svg.transition().call(zoom.scaleBy, 1.3);
    document.getElementById('zoom-out').onclick = () => svg.transition().call(zoom.scaleBy, 0.77);
    document.getElementById('reset-zoom').onclick = () => svg.transition().call(zoom.transform, d3.zoomIdentity);

    return {
      update(newGraph) {
        workingNodes = newGraph.nodes.map(n => ({...n}));
        workingLinks = newGraph.links.map(l => ({...l}));
        rebuild();
      },
      destroy() {
        simulation.stop();
        svg.remove();
      },
    };
  }

  // Expose
  M.render = render;
  M.pitchOf = pitchOf;
})();
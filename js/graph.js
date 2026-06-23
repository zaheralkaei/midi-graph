// graph.js — D3 force-directed graph for the transition network.
//
// Public API:
//   MidiGraph.render(containerEl, graph)   → controller {
//     update(graph), destroy(),
//     setActive(cents, on), clearActive(),
//   }
//
// The graph shape is { nodes: [{id}], links: [{source, target, value}] }
// produced by MidiGraph.buildTransitionGraph(). Cents-based: node IDs are
// spelled-out pitch names like "C4" or "C# half-sharp 4".

(function () {
  const M = window.MidiGraph;

  // 24 pitch classes (12 naturals/sharps + 12 half-sharps). One distinct color
  // each. Generated in HSL space so every class gets a perceptually
  // distinguishable hue. Naturals/sharps use full saturation; half-sharps
  // use lower saturation so they read as "between" their neighbors.
  const PITCH_CLASSES = M.PITCH_CLASSES;  // 24 names per octave
  const pitchClassColor = (function () {
    // 24 hues = 360/15 degrees apart. Half-sharp colors start at hue offset 7.5°
    // so they sit visually between their sharp neighbor and the next natural.
    const colors = {};
    PITCH_CLASSES.forEach((name, i) => {
      // Quarter-tone classes (now using the ↑ symbol) get lower saturation
      // and higher lightness so they read as "between" their sharp neighbors.
      const isHalfSharp = name.includes('half-sharp') || name.includes('\u2191');
      const hue = i * 15;  // 0, 15, 30, ..., 345
      const sat = isHalfSharp ? 55 : 80;
      const light = isHalfSharp ? 70 : 55;
      colors[name] = `hsl(${hue}, ${sat}%, ${light}%)`;
    });
    return (name) => colors[name] || '#00e5ff';
  })();

  // 12-entry sharp-spelling scale. NOTE: do NOT use M.NOTE_NAMES (which is the
  // 24-entry QUARTER_TONE_NAMES) for index lookups in pitchOf() — the indexes
  // don't line up. The quarter-tone "A" is at index 18 in the 24-entry scale
  // but at index 9 in the 12-entry scale; mixing them produced wrong cents
  // for every non-C note (broke the playback glow and the pitch-range filter
  // sliders).
  const SHARP_SCALE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

  // Parse a pitch-id like "F#5", "C half-sharp 5", or "C↑5" back to cents
  // above C0. Supports three notations:
  //   - "C4"             — natural/sharp (cents = oct*1200 + pc*100)
  //   - "C half-sharp 4" — long-form quarter-tone (legacy, kept for compat)
  //   - "C half-flat 4"  — long-form quarter-tone (legacy, kept for compat)
  //   - "C↑4"            — short-form quarter-tone (current emit format)
  //
  // Regex anatomy:
  //   ^([A-G][#]?)                  - letter + optional sharp
  //   (?: \u2191 )?                  - optional up-arrow (current short form)
  //   OR (?: (half-(?:sharp|flat)) )?  - optional " half-sharp" / " half-flat"
  //                                  (legacy form, trailing space INSIDE the
  //                                  group, since centsToPitch emitted
  //                                  "C half-sharp 4" before the rename)
  //   (-?\d+)$                      - octave number (negative for sub-audio)
  function pitchOf(id) {
    if (id == null) return 6000;
    // Match either the short form (C↑4) or the legacy long form
    // (C half-sharp 4 / C half-flat 4). Both alternatives are wrapped in
    // non-capturing groups so the octave capture (m[2]) is consistent
    // regardless of which form matched.
    const m = id.match(/^([A-G][#]?)(?:\u2191| (?:half-(?:sharp|flat)) )?(-?\d+)$/);
    if (!m) return 6000;
    const pc = SHARP_SCALE_NAMES.indexOf(m[1]);
    if (pc < 0) return 6000;
    const octave = parseInt(m[2], 10);
    const isQuarter = m[1] && (id.indexOf('\u2191') >= 0 || /half-/.test(id));
    const centsInOctave = pc * 100 + (isQuarter ? 50 : 0);
    return (octave + 1) * 1200 + centsInOctave;
  }

  function render(container, graph) {
    // CSS-driven SVG sizing — never trust clientWidth/clientHeight here.
    const svg = d3.select(container).append('svg')
      .attr('width', '100%')
      .attr('height', '100%')
      .attr('viewBox', null);
    const g = svg.append('g');

    // SVG <defs> with arrow markers for directed edges. Two markers exist:
    // - 'arrow' (default gray) for unhovered edges
    // - 'arrow-hover' (white) for the currently-hovered edge
    //
    // The marker is oriented automatically along the path tangent, and refX
    // is the point on the marker that anchors to the path endpoint.
    // markerUnits='userSpaceOnUse' makes the arrow the same size regardless
    // of stroke thickness (default 'strokeWidth' would scale with edge width).
    function makeArrow(id, fill) {
      svg.select('defs').append('marker')
        .attr('id', id)
        .attr('viewBox', '0 -5 10 10')
        .attr('refX', 9)         // tip of arrow
        .attr('refY', 0)
        .attr('markerWidth', 8)
        .attr('markerHeight', 8)
        .attr('orient', 'auto')
        .attr('markerUnits', 'userSpaceOnUse')
        .append('path')
        .attr('d', 'M0,-4 L9,0 L0,4 z')
        .attr('fill', fill);
    }
    svg.append('defs');
    makeArrow('arrow', '#666');
    makeArrow('arrow-hover', '#fff');

    const zoom = d3.zoom()
      .scaleExtent([0.3, 8])
      .on('zoom', e => g.attr('transform', e.transform));
    svg.call(zoom);

    function getSize() {
      const r = container.getBoundingClientRect();
      return { w: Math.max(200, r.width), h: Math.max(200, r.height) };
    }

    const linkGroup = g.append('g').attr('class', 'links');
    const linkLabelGroup = g.append('g').attr('class', 'link-labels');
    const selfLoopLabelGroup = g.append('g').attr('class', 'self-loop-labels');
    const nodeGroup = g.append('g').attr('class', 'nodes');
    const labelGroup = g.append('g').attr('class', 'node-labels');

    let workingNodes = graph.nodes.map(n => ({...n}));
    let workingLinks = graph.links.map(l => ({...l}));

    // Active-node tracking for playback glow.
    // Map cents → number of currently-sounding voices on that pitch.
    // Decremented on note-off so overlapping notes keep the glow on.
    const activeCount = new Map();
    const activeName = new Map();   // cents → node id (e.g. "C# half-sharp 4")

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

      // Self-loop labels
      const selfLoops = links.filter(d => d.source === d.target);
      const loopLabelSel = selfLoopLabelGroup.selectAll('text').data(selfLoops, d => d.source);
      loopLabelSel.exit().remove();
      loopLabelSel.enter().append('text')
        .attr('class', 'self-loop-label')
        .merge(loopLabelSel)
        .text(d => (d.value * 100).toFixed(0) + '%');

      // Other-edge labels (hidden by default, shown on edge hover via CSS).
      const otherLinks = links.filter(d => d.source !== d.target);
      const linkLabelSel = linkLabelGroup.selectAll('text').data(otherLinks, d => d.source + '->' + d.target);
      linkLabelSel.exit().remove();
      const linkLabelEnter = linkLabelSel.enter().append('text')
        .attr('class', 'link-label')
        .attr('text-anchor', 'middle');
      const linkLabelAll = linkLabelEnter.merge(linkLabelSel)
        .text(d => (d.value * 100).toFixed(0) + '%')
        // Dim low-probability labels so dense graphs stay readable.
        .attr('class', d => d.value < 0.1 ? 'link-label dim' : 'link-label');

      // ----- Nodes -----
      const nodeSel = nodeGroup.selectAll('circle').data(nodes, d => d.id);
      nodeSel.exit().remove();
      // Drag mode depends on the "Pin dragged nodes" checkbox. Default is
      // REARRANGE (checkbox unchecked): dragged nodes snap back when released
      // (fx/fy cleared, force simulation continues). When the box is checked
      // (PIN mode): fx/fy are left set, the dragged node stays put and the
      // simulation continues to re-settle everything else around it.
      const nodeEnter = nodeSel.enter().append('circle').attr('r', 18);
      const nodeAll = nodeEnter.merge(nodeSel)
        .call(d3.drag()
          .on('start', (e, d) => { if (!e.active) simulation.alphaTarget(0.3).restart(); d.fx = e.x; d.fy = e.y; })
          .on('drag',  (e, d) => { d.fx = e.x; d.fy = e.y; })
          .on('end',   (e, d) => {
            if (!e.active) simulation.alphaTarget(0);
            const pin = document.getElementById('drag-pin-mode').checked;
            if (!pin) { d.fx = null; d.fy = null; }
            // In PIN mode, leave d.fx/d.fy set so the node stays where the
            // user dropped it. The simulation still settles other nodes around it.
          }));

      const colorByClass = document.getElementById('color-by-pitch-class').checked;
      nodeAll
        .attr('fill', d => colorByClass ? pitchClassColor(M.pitchClass(pitchOf(d.id))) : '#00e5ff')
        .attr('class', d => {
          // Preserve any active-glow class on rebuild.
          const cents = pitchOf(d.id);
          return activeCount.get(cents) > 0 ? 'node active' : 'node';
        })
        .each(function(d) { activeName.set(pitchOf(d.id), d.id); })
        .append('title').text(d => d.id);

      // ----- Node labels (with text-stroke for contrast against any circle color) -----
      const labelSel = labelGroup.selectAll('text').data(nodes, d => d.id);
      labelSel.exit().remove();
      labelSel.enter().append('text')
        .attr('class', 'node-label')
        .attr('text-anchor', 'middle')
        .attr('dy', 4)
        .merge(labelSel)
        .text(d => d.id);

      // Edge hover: highlight the edge + swap to the white arrow marker.
      // (Labels are now always visible — was previously toggled via .visible
      // class on hover, but that's gone.)
      linkAll
        .on('mouseenter', function(ev, d) {
          d3.select(this).attr('stroke', '#fff').attr('stroke-opacity', 1)
            .attr('marker-end', 'url(#arrow-hover)');
        })
        .on('mouseleave', function(ev, d) {
          d3.select(this).attr('stroke', '#666').attr('stroke-opacity', 0.55)
            .attr('marker-end', 'url(#arrow)');
        });

      // ----- Tick -----
      simulation.nodes(nodes);
      simulation.force('link').links(links);
      simulation.alpha(0.9).restart();

      simulation.on('tick', () => {
        const thicknessOn = document.getElementById('edge-thickness-by-prob').checked;
        const { w, h } = getSize();
        simulation.force('center').x(w / 2).y(h / 2);
        // Node radius (must match the .attr('r', 18) on enter() below).
        const NODE_R = 18;
        // Shrink edges by this much past the node circumference so the arrow
        // head doesn't overlap the target node. The marker is anchored at
        // refX=9 and the arrow tip extends a few more units, so we shrink by
        // NODE_R + 4 to keep the tip just outside the node circle.
        const ARROW_GAP = NODE_R + 4;
        linkAll
          .attr('d', d => {
            if (d.source === d.target) {
              // Self-loop: small arc above the node. The arc starts at
              // (x-8, y-8), goes up and around, ends at (x+8, y-8). The
              // marker is drawn at the arc end, oriented along the tangent.
              const x = d.source.x, y = d.source.y;
              return `M${x-8},${y-8} A14,14 0 1,1 ${x+8},${y-8}`;
            }
            // Shorten the path so it stops just outside the target node.
            // Vector from source to target, normalize, multiply by gap.
            const dx = d.target.x - d.source.x, dy = d.target.y - d.source.y;
            const len = Math.sqrt(dx * dx + dy * dy);
            if (len < 1) return '';  // nodes overlap, skip
            const ux = dx / len, uy = dy / len;
            const endX = d.target.x - ux * ARROW_GAP;
            const endY = d.target.y - uy * ARROW_GAP;
            // Use a quadratic curve that bows out a bit so the arrow is
            // clearly inside the line, not on top of it.
            const midX = (d.source.x + endX) / 2 + uy * 15;
            const midY = (d.source.y + endY) / 2 - ux * 15;
            return `M${d.source.x},${d.source.y} Q${midX},${midY} ${endX},${endY}`;
          })
          .attr('stroke', '#666')
          .attr('stroke-opacity', 0.55)
          .attr('fill', 'none')
          .attr('stroke-width', d => thicknessOn ? 0.5 + d.value * 5 : 1.5)
          .attr('marker-end', 'url(#arrow)');

        selfLoopLabelGroup.selectAll('text')
          .attr('x', d => d.source.x)
          .attr('y', d => d.source.y - 22);

        linkLabelAll
          .attr('x', d => (d.source.x + d.target.x) / 2)
          .attr('y', d => (d.source.y + d.target.y) / 2 - 4);

        nodeAll.attr('cx', d => d.x).attr('cy', d => d.y);
        labelSel.attr('x', d => d.x).attr('y', d => d.y);
      });
    }

    // Active-note glow controller. Called by playback.js via callbacks.
    function setActive(cents, on) {
      const name = activeName.get(cents);
      if (!name) return;  // node was filtered out; nothing to glow
      const cur = activeCount.get(cents) || 0;
      const next = on ? cur + 1 : Math.max(0, cur - 1);
      if (next === 0) activeCount.delete(cents);
      else activeCount.set(cents, next);
      nodeGroup.selectAll('circle')
        .filter(d => d.id === name)
        .classed('active', next > 0);
    }
    function clearActive() {
      activeCount.clear();
      nodeGroup.selectAll('circle').classed('active', false);
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
      document.getElementById('min-pitch-val').textContent = M.centsToPitch(+e.target.value);
      rebuild();
    });
    maxPitchInput.addEventListener('input', e => {
      document.getElementById('max-pitch-val').textContent = M.centsToPitch(+e.target.value);
      rebuild();
    });
    colorToggle.addEventListener('change', rebuild);
    thicknessToggle.addEventListener('change', rebuild);

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
      setActive,
      clearActive,
    };
  }

  M.render = render;
  M.pitchOf = pitchOf;
})();
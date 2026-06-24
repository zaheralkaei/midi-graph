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

  // Phase 3: chord-label color by quality. Quarter-tone / literal-spelling
  // chords get a distinct purple so the user can spot them at a glance.
  // Major = blue, minor = teal, diminished = orange, augmented = red,
  // suspended = gray, 7th variants = desaturated, power = white,
  // dominant 7 = amber.
  function chordColor(label) {
    if (label === '(silence)') return '#555';
    if (label.includes('(') && label.includes(')')) return '#a878e8'; // literal-spelling
    if (label.endsWith('m7b5')) return '#b08c5c';     // half-diminished
    if (label.endsWith('dim7')) return '#d97706';
    if (label.endsWith('m7')) return '#5fb3a8';
    if (label.endsWith('maj7')) return '#5b8def';
    if (label.endsWith('7b9') || label.endsWith('7#9')) return '#e09940';
    if (label.endsWith('9') || label.endsWith('13')) return '#8aa8c9';
    if (label.endsWith('7')) return '#e0a040';         // dominant 7
    if (label.endsWith('6')) return '#7da3d9';
    if (label.endsWith('m')) return '#5fb3a8';         // minor triad
    if (label.endsWith('dim')) return '#d97706';
    if (label.endsWith('aug')) return '#e05555';
    if (label.endsWith('sus4') || label.endsWith('sus2')) return '#9aa0a6';
    if (label.endsWith('add9') || label.endsWith('madd9')) return '#a8c4d9';
    if (label === 'C' || label === 'D' || label === 'E' || label === 'F' ||
        label === 'G' || label === 'A' || label === 'B' ||
        /^([A-G])(?:#|b)?$/.test(label)) return '#5b8def';  // bare major triad
    if (label === 'C5' || label === 'D5' || /^[A-G]5$/.test(label)) return '#cccccc';
    return '#888';   // unknown
  }

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
    // Match the display forms produced by centsToPitch / centsToStepAlterOctave:
    //   short form:   "C↑4", "C#4", "E half-flat 4"
    //   legacy form:  "D#↑4" (still accepted for backward compat)
    // Three matching groups: letter (with optional sharp), alteration
    // (either `↑`, `half-sharp `, `half-flat `, or empty), octave.
    const m = id.match(/^([A-G][#]?)(?:\u2191| half-sharp | half-flat )?(-?\d+)$/);
    if (!m) return 6000;
    const pc = SHARP_SCALE_NAMES.indexOf(m[1]);
    if (pc < 0) return 6000;
    const octave = parseInt(m[2], 10);
    // Determine alteration:
    //   legacy `↑` suffix (old display)           → +50
    //   `half-sharp ` (new display, no flat equiv) → +50
    //   `half-flat `                              → -50
    //   neither                                    →   0
    let centsInOctave = pc * 100;
    if (id.indexOf('half-flat') >= 0) centsInOctave -= 50;
    else if (id.indexOf('\u2191') >= 0 || id.indexOf('half-sharp') >= 0) centsInOctave += 50;
    // Wrap into [0, 1200).
    centsInOctave = ((centsInOctave % 1200) + 1200) % 1200;
    return (octave + 1) * 1200 + centsInOctave;
  }

  // Phase 3: render takes an options object as its third argument.
  // options.mode = 'pitch' (default) renders a pitch-transition graph with
  // pitch-class coloring and playback glow.
  // options.mode = 'chord' renders a chord-transition graph with
  // quality-based coloring and no playback glow.
  function render(container, graph, options = {}) {
    const mode = options.mode || 'pitch';
    const isChord = mode === 'chord';
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
      // Node radius (must match the .attr('r', 18) on the circle enter()
      // below). Used for label positioning (offset to the right of node),
      // arrow tip clearance, and the collide force.
      const NODE_R = 18;
      // Control IDs are scoped per-graph. The melodic graph reads
      // `#min-prob`, `#color-by-pitch-class`, etc.; the harmonic
      // graph reads `#harmonic-min-prob`, `#harmonic-color-by-quality`,
      // etc. The caller passes `options.controlPrefix` so each
      // render() instance binds to its own panel's controls. The
      // default prefix '' keeps the existing melodic behavior.
      const ctl = options.controlPrefix || '';
      const minProb = +document.getElementById(ctl + 'min-prob').value / 100;
      // Pitch-range sliders only exist on the melodic panel
      // (#min-pitch / #max-pitch). The harmonic panel doesn't have
      // them, so we skip the cents-based filter in chord mode.
      const minPitch = ctl ? null : +document.getElementById('min-pitch').value;
      const maxPitch = ctl ? null : +document.getElementById('max-pitch').value;

      const filtered = workingLinks.filter(l => {
        if (isChord) {
          // Chord mode: only the probability filter applies. There's
          // no pitch-based filter because chord IDs are strings
          // (e.g. "C", "F/A", "Am7b5"), not cents.
          return l.value >= minProb;
        }
        // Pitch mode: probability + cents range. minPitch/maxPitch
        // are null when ctl is non-empty (harmonic panel), so the
        // sp >= null / sp <= null checks are false for any number
        // and the filter becomes a no-op (correct — harmonic shouldn't
        // have a pitch filter).
        const sp = pitchOf(l.source);
        const tp = pitchOf(l.target);
        return l.value >= minProb
          && (minPitch === null || sp >= minPitch)
          && (maxPitch === null || sp <= maxPitch)
          && (minPitch === null || tp >= minPitch)
          && (maxPitch === null || tp <= maxPitch);
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

      // Self-loop labels — distinct visual treatment from regular edge labels so
      // they stand out at a glance: brighter color, larger size, positioned 26px
      // above the node (above the regular edge labels which sit at midpoint).
      // Always visible (was hover-only in the previous CSS revision).
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
            const pin = document.getElementById(ctl + 'drag-pin-mode').checked;
            if (!pin) { d.fx = null; d.fy = null; }
            // In PIN mode, leave d.fx/d.fy set so the node stays where the
            // user dropped it. The simulation still settles other nodes around it.
          }));

      // Color checkbox. Melodic uses `color-by-pitch-class` (default
      // cyan vs pitch-class palette); harmonic uses the same ID
      // but the label says "Color by quality" because the palette
      // is `chordColor` (per-quality) instead of `pitchClassColor`
      // (per-pitch-class). When the box is UNCHECKED, both modes
      // fall back to the default accent color.
      const colorByClass = document.getElementById(ctl + 'color-by-pitch-class').checked;
      nodeAll
        .attr('fill', d => {
          if (isChord) return colorByClass ? chordColor(d.id) : '#00e5ff';
          return colorByClass ? pitchClassColor(M.pitchClass(pitchOf(d.id))) : '#00e5ff';
        })
        .attr('class', d => {
          if (isChord) return 'node';   // no playback glow in chord mode
          // Preserve any active-glow class on rebuild.
          const cents = pitchOf(d.id);
          return activeCount.get(cents) > 0 ? 'node active' : 'node';
        })
        .each(function(d) {
          if (!isChord) activeName.set(pitchOf(d.id), d.id);
        });
      // Tooltip (browser-native <title>, shown on hover). Only attach to
      // newly-entered circles — appending on every rebuild would stack
      // titles. The text uses the current d.id / d.count / d.frequency
      // (which may update across rebuilds when nodes filter in/out).
      nodeEnter
        .append('title')
        .text(d => {
          const pct = (d.frequency * 100).toFixed(2);
          if (isChord) {
            return `${d.id} — ${d.count} chord${d.count === 1 ? '' : 's'} (${pct}% of progression)`;
          }
          return `${d.id} — ${d.count} occurrence${d.count === 1 ? '' : 's'} (${pct}% of piece)`;
        });

      // ----- Node labels (positioned to the right of each node, with the
      // absolute frequency appended as a percentage of the whole piece).
      // Two-line label: line 1 = pitch name (e.g. "C4"), line 2 = "N% of piece"
      // (e.g. "8%"). Using a tspan lets the two lines share a single text
      // element so positioning stays simple. dark text with light stroke
      // works on any background; placed right of the node so it doesn't
      // overlap the circle's interior — the previous inside-the-circle
      // placement was hard to read on light-colored nodes (yellow, etc).
      // Labels are drawn INSIDE the node circle (not beside it). With
      // NODE_R=18 the inner diameter is 36px, so we use a small font
      // (8.5px) and 2 short lines: pitch name on top, frequency % on
      // the bottom. text-anchor=middle and dominant-baseline=central
      // center the text on the node's (x, y) — no dx needed.
      // In chord mode the labels can be longer ("Cm7b5", "Dm7b5/Eb")
      // so we use a smaller font. The user wanted the chord graph to
      // look like the pitch graph — chord name on top, frequency %
      // on a second line. The absolute count is in the tooltip.
      const labelSel = labelGroup.selectAll('text').data(nodes, d => d.id);
      labelSel.exit().remove();
      const labelEnter = labelSel.enter().append('text')
        .attr('class', isChord ? 'node-label chord-label' : 'node-label')
        .attr('text-anchor', 'middle')
        .attr('dominant-baseline', 'central')
        .attr('dy', isChord ? '-0.45em' : '-0.45em');
      // First tspan: pitch name or chord label. Sits on the upper half
      // for both modes (chord mode mirrors the pitch-graph layout —
      // name on top, frequency % on the second line).
      labelEnter.append('tspan').attr('class', 'node-label-name');
      // Second tspan: count and frequency % on the line below the name.
      // Format: "5  2.4%" — absolute count and percentage separated
      // by a non-breaking space. The user wanted both numbers visible
      // at a glance. The label is hidden if it would overflow the
      // panel (clipped by overflow:hidden on the parent).
      labelEnter.append('tspan').attr('class', 'node-label-freq')
        .attr('dy', '0.9em')
        .attr('x', 0);  // reset the relative dx from the parent tspan
      labelSel.merge(labelEnter).select('.node-label-name')
        .text(d => d.id);
      labelSel.merge(labelEnter).select('.node-label-freq')
        .text(d => {
          const pct = (d.frequency || 0) * 100;
          const cnt = d.count || 0;
          // Two decimals for sub-1% pitches (vp2-1all.mid has many).
          return `${cnt}\u00a0\u00a0${pct < 1 ? pct.toFixed(2) : pct.toFixed(1)}%`;
        });

      // Edge hover: highlight the edge + swap to the white arrow marker.
      // (Labels are now always visible — was previously toggled via .visible
      // class on hover, but that's gone.)
      // Tooltip: a browser-native <title> attached to each edge path. The
      // d.count and d.value fields come from buildTransitionGraph (count
      // = number of times this transition occurred, value = count/cur_total
      // = transition probability for this source's outgoing edges).
      linkAll.append('title')
        .text(d => {
          const src = typeof d.source === 'object' ? d.source.id : d.source;
          const tgt = typeof d.target === 'object' ? d.target.id : d.target;
          const pct = (d.value * 100);
          const pctStr = pct < 1 ? pct.toFixed(2) : pct.toFixed(1);
          return `${src} → ${tgt} — ${d.count}× (${pctStr}% of outgoing from ${src})`;
        });
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
        const thicknessOn = document.getElementById(ctl + 'edge-thickness-by-prob').checked;
        const { w, h } = getSize();
        simulation.force('center').x(w / 2).y(h / 2);
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
        // Labels are positioned to the right of each node. The text
        // element's x is the node's x; the dx and dominant-baseline on
        // the <text> handle the offset.
        // CRITICAL: use the MERGED label selection (enter + update), not
        // just labelSel. On first load, labelSel is the empty update
        // selection, and labelEnter holds all the actual <text> nodes.
        // Without .merge(), the tick handler would set x/y on zero elements
        // and the labels would stay at (0, 0) — drawn at the SVG's
        // top-left, not next to their nodes.
        const labelAll = labelSel.merge(labelEnter);
        labelAll.attr('x', d => d.x).attr('y', d => d.y);
        // The frequency tspan has x=0 set statically (to reset the
        // parent's relative dx). We need to override that to the
        // node's actual x so the second line centers on the node,
        // not the SVG's left edge. Without this, "0.91%" appears at
        // SVG (0, ~node.y) instead of centered under "A#3".
        labelAll.select('.node-label-freq').attr('x', d => d.x);
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
    // Phase 3: chord-mode glow. The chord graph's node ids are the
    // chord labels themselves (e.g. "C neutral triad"), so we just
    // toggle .active on the matching circle. Reference-counted so
    // overlapping chord windows don't double-glow.
    const chordActiveCount = new Map();   // chord label → int
    function setActiveChord(label, on) {
      const cur = chordActiveCount.get(label) || 0;
      const next = on ? cur + 1 : Math.max(0, cur - 1);
      if (next === 0) chordActiveCount.delete(label);
      else chordActiveCount.set(label, next);
      nodeGroup.selectAll('circle')
        .filter(d => d.id === label)
        .classed('active', next > 0);
    }
    function clearActive() {
      activeCount.clear();
      chordActiveCount.clear();
      nodeGroup.selectAll('circle').classed('active', false);
    }

    rebuild();

    // Filter control listeners. The ctl prefix is computed locally
    // (it was defined inside rebuild() too — rebuild() and this
    // function are sibling closures over the render() arguments).
    const ctl2 = options.controlPrefix || '';
    const probInput = document.getElementById(ctl2 + 'min-prob');
    const minPitchInput = ctl2 ? null : document.getElementById('min-pitch');
    const maxPitchInput = ctl2 ? null : document.getElementById('max-pitch');
    const colorToggle = document.getElementById(ctl2 + 'color-by-pitch-class');
    const thicknessToggle = document.getElementById(ctl2 + 'edge-thickness-by-prob');
    const dragPinToggle = document.getElementById(ctl2 + 'drag-pin-mode');

    probInput.addEventListener('input', e => {
      document.getElementById(ctl2 + 'min-prob-val').textContent = e.target.value + '%';
      rebuild();
    });
    if (minPitchInput) {
      minPitchInput.addEventListener('input', e => {
        document.getElementById('min-pitch-val').textContent = M.centsToPitch(+e.target.value);
        rebuild();
      });
    }
    if (maxPitchInput) {
      maxPitchInput.addEventListener('input', e => {
        document.getElementById('max-pitch-val').textContent = M.centsToPitch(+e.target.value);
        rebuild();
      });
    }
    if (colorToggle) colorToggle.addEventListener('change', rebuild);
    if (thicknessToggle) thicknessToggle.addEventListener('change', rebuild);
    // drag-pin-mode doesn't trigger a rebuild on change — the toggle
    // is read at drag-end time (see the drag handler above), so
    // there's nothing to listen for here.

    // Zoom buttons — by default hard-coded to #zoom-in / #zoom-out /
    // #reset-zoom (the pitch-mode panel). For chord mode the caller
    // passes options.zoomButtonPrefix = 'harmonic-' so we bind to
    // #harmonic-zoom-in instead. Both button sets work because each
    // render() call gets its own svg + zoom controller.
    const prefix = options.zoomButtonPrefix || '';
    const zin = document.getElementById(prefix + 'zoom-in');
    const zout = document.getElementById(prefix + 'zoom-out');
    const zreset = document.getElementById(prefix + 'reset-zoom');
    if (zin)  zin.onclick  = () => svg.transition().call(zoom.scaleBy, 1.3);
    if (zout) zout.onclick = () => svg.transition().call(zoom.scaleBy, 0.77);
    if (zreset) zreset.onclick = () => svg.transition().call(zoom.transform, d3.zoomIdentity);

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
      setActiveChord,
      clearActive,
      zoomIn()  { if (zin)  zin.click(); },
      zoomOut() { if (zout) zout.click(); },
      resetZoom() { if (zreset) zreset.click(); },
    };
  }

  M.render = render;
  M.pitchOf = pitchOf;
})();
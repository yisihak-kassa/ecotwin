// ---------------------------------------------------------------------------
// Connector routing, rendering and editing
// ---------------------------------------------------------------------------

var AUTO_ROUTE_CLEARANCE = 24;
var CONNECTOR_JOIN_EPSILON = 2;

function isNodeAnchor(anchor) {
  return !!anchor && anchor.kind === 'anchor' && !!anchor.node;
}

function resolveNodeAnchor(anchor) {
  if (!anchor || !anchor.node) return [0, 0];
  var b = box('N-' + anchor.node);
  return [b.l + anchor.fx * b.w, b.t + anchor.fy * b.h];
}

function resolveConnectorVertexPoint(connector, vertexId) {
  var vertex = connectorVertex(connector, vertexId);
  if (!vertex) return [0, 0];
  return vertex.kind === 'point' ? [vertex.x, vertex.y] : resolveNodeAnchor(vertex);
}

function findConnectorById(id) {
  return connectors.find(function(connector) { return connector.id === id; }) || null;
}

function connectorEdgePoints(connector, edge) {
  return [resolveConnectorVertexPoint(connector, edge.from), resolveConnectorVertexPoint(connector, edge.to)];
}

function connectorRoutePoints(connector, terminalOrVertex) {
  var terminalVertexId = typeof terminalOrVertex === 'string'
    ? terminalOrVertex : terminalOrVertex && terminalOrVertex.vertex;
  return connectorPathToTerminal(connector, terminalVertexId).vertexIds.map(function(vertexId) {
    return resolveConnectorVertexPoint(connector, vertexId);
  });
}

function connectorTerminalForVertex(connector, vertexId) {
  return (connector.terminals || []).find(function(terminal) { return terminal.vertex === vertexId; }) || null;
}

function connectorTerminalForEdge(connector, edgeId) {
  var edge = connectorEdgeById(connector, edgeId);
  return edge ? connectorTerminalForVertex(connector, edge.to) : null;
}

function connectorTerminalMarker(connector, edgeId) {
  var terminal = connectorTerminalForEdge(connector, edgeId);
  return terminal ? terminal.marker : null;
}

function loadConnectors() {
  if (READONLY) return cloneConnectorValue(DEFAULT_CONNECTORS);
  try {
    var savedV3Raw = lsGet(CONNECTORS_KEY);
    if (savedV3Raw) {
      var savedV3 = JSON.parse(savedV3Raw);
      if (Array.isArray(savedV3) && savedV3.every(function(item) { return item && item.kind === 'tree'; })) return savedV3;
    }
  } catch (e) {}
  try {
    var savedV2Raw = lsGet(LEGACY_ARROWS_KEY);
    if (savedV2Raw) {
      var savedV2 = JSON.parse(savedV2Raw);
      if (Array.isArray(savedV2) && savedV2.length && !savedV2.every(function(item) { return item && item.kind === 'tree'; })) {
        legacyArrowsForMigration = savedV2;
        var migrated = migrateLegacyArrows(savedV2, resolveLegacyArrowPoints, CONNECTOR_JOIN_EPSILON);
        lsSet(CONNECTORS_KEY, JSON.stringify(migrated));
        legacyArrowsForMigration = [];
        return migrated;
      }
    }
  } catch (e) { legacyArrowsForMigration = []; }
  return cloneConnectorValue(DEFAULT_CONNECTORS);
}

function saveConnectors() {
  try { lsSet(CONNECTORS_KEY, JSON.stringify(connectors)); } catch (e) {}
}

// Legacy resolver used only for the one-time v2 -> v3 localStorage migration.
var legacyArrowsForMigration = [];

function legacyArrowById(id) {
  return legacyArrowsForMigration.find(function(arrow) { return arrow.id === id; }) || null;
}

function legacyResolveAnchor(anchor, guard) {
  if (anchor.arrow) {
    guard = guard || {};
    if (guard[anchor.arrow]) return [0, 0];
    guard[anchor.arrow] = true;
    var trunk = legacyArrowById(anchor.arrow);
    var points = trunk ? resolveLegacyArrowPoints(trunk, guard) : [[0, 0], [0, 0]];
    delete guard[anchor.arrow];
    var segment = Math.max(0, Math.min(points.length - 2, anchor.seg | 0));
    var t = Math.max(0, Math.min(1, Number(anchor.t) || 0));
    return [points[segment][0] + t * (points[segment + 1][0] - points[segment][0]),
      points[segment][1] + t * (points[segment + 1][1] - points[segment][1])];
  }
  if (anchor.free) return [anchor.x, anchor.y];
  return resolveNodeAnchor({ kind: 'anchor', node: anchor.node, fx: anchor.fx, fy: anchor.fy });
}

function legacyNodeAnchorFace(anchor) {
  if (!anchor || anchor.free || anchor.arrow) return null;
  if (anchor.fx === 0) return 'left';
  if (anchor.fx === 1) return 'right';
  if (anchor.fy === 0) return 'top';
  if (anchor.fy === 1) return 'bottom';
  return null;
}

function legacyTapIsHorizontal(anchor, guard) {
  var trunk = anchor && anchor.arrow && legacyArrowById(anchor.arrow);
  if (!trunk) return null;
  var points = resolveLegacyArrowPoints(trunk, guard);
  var i = Math.max(0, Math.min(points.length - 2, anchor.seg | 0));
  return Math.abs(points[i + 1][0] - points[i][0]) >= Math.abs(points[i + 1][1] - points[i][1]);
}

function legacyAutoRoute(arrow, guard) {
  var source = legacyResolveAnchor(arrow.src, guard), target = legacyResolveAnchor(arrow.dst, guard);
  var leaveHorizontal = arrow.src.arrow ? !legacyTapIsHorizontal(arrow.src, guard)
    : (arrow.src.fx === 0 || arrow.src.fx === 1);
  var arriveHorizontal = !(arrow.dst.fy === 0 || arrow.dst.fy === 1), middle;
  if (leaveHorizontal && !arriveHorizontal) middle = [[target[0], source[1]]];
  else if (!leaveHorizontal && arriveHorizontal) middle = [[source[0], target[1]]];
  else if (leaveHorizontal) {
    var sourceFaceH = legacyNodeAnchorFace(arrow.src), targetFaceH = legacyNodeAnchorFace(arrow.dst), x;
    if (sourceFaceH === targetFaceH && sourceFaceH === 'left') x = Math.min(source[0], target[0]) - AUTO_ROUTE_CLEARANCE;
    else if (sourceFaceH === targetFaceH && sourceFaceH === 'right') x = Math.max(source[0], target[0]) + AUTO_ROUTE_CLEARANCE;
    else x = (source[0] + target[0]) / 2;
    middle = [[x, source[1]], [x, target[1]]];
  } else {
    var sourceFaceV = legacyNodeAnchorFace(arrow.src), targetFaceV = legacyNodeAnchorFace(arrow.dst), y;
    if (sourceFaceV === targetFaceV && sourceFaceV === 'top') y = Math.min(source[1], target[1]) - AUTO_ROUTE_CLEARANCE;
    else if (sourceFaceV === targetFaceV && sourceFaceV === 'bottom') y = Math.max(source[1], target[1]) + AUTO_ROUTE_CLEARANCE;
    else y = (source[1] + target[1]) / 2;
    middle = [[source[0], y], [target[0], y]];
  }
  return [source].concat(middle).concat([target]);
}

function resolveLegacyArrowPoints(arrow, guard) {
  if (arrow.waypoints && arrow.waypoints.length) {
    return [legacyResolveAnchor(arrow.src, guard)]
      .concat(arrow.waypoints.map(function(point) { return point.slice(); }))
      .concat([legacyResolveAnchor(arrow.dst, guard)]);
  }
  return legacyAutoRoute(arrow, guard);
}

function nodeAnchorFace(anchor) {
  if (!isNodeAnchor(anchor)) return null;
  if (anchor.fx === 0) return 'left';
  if (anchor.fx === 1) return 'right';
  if (anchor.fy === 0) return 'top';
  if (anchor.fy === 1) return 'bottom';
  return null;
}

function routeBetweenAnchors(sourceAnchor, targetAnchor) {
  var source = resolveNodeAnchor(sourceAnchor), target = resolveNodeAnchor(targetAnchor);
  var sourceFace = nodeAnchorFace(sourceAnchor), targetFace = nodeAnchorFace(targetAnchor);
  if (Math.abs(source[1] - target[1]) < 0.5 &&
      ((sourceFace === 'right' && targetFace === 'left' && target[0] > source[0]) ||
       (sourceFace === 'left' && targetFace === 'right' && target[0] < source[0]))) return [source, target];
  if (Math.abs(source[0] - target[0]) < 0.5 &&
      ((sourceFace === 'bottom' && targetFace === 'top' && target[1] > source[1]) ||
       (sourceFace === 'top' && targetFace === 'bottom' && target[1] < source[1]))) return [source, target];
  var leaveHorizontal = sourceFace === 'left' || sourceFace === 'right';
  var arriveHorizontal = targetFace === 'left' || targetFace === 'right';
  if (leaveHorizontal && !arriveHorizontal) return [source, [target[0], source[1]], target];
  if (!leaveHorizontal && arriveHorizontal) return [source, [source[0], target[1]], target];
  if (leaveHorizontal) {
    var x = sourceFace === targetFace && sourceFace === 'left'
      ? Math.min(source[0], target[0]) - AUTO_ROUTE_CLEARANCE
      : sourceFace === targetFace && sourceFace === 'right'
        ? Math.max(source[0], target[0]) + AUTO_ROUTE_CLEARANCE : (source[0] + target[0]) / 2;
    return [source, [x, source[1]], [x, target[1]], target];
  }
  var y = sourceFace === targetFace && sourceFace === 'top'
    ? Math.min(source[1], target[1]) - AUTO_ROUTE_CLEARANCE
    : sourceFace === targetFace && sourceFace === 'bottom'
      ? Math.max(source[1], target[1]) + AUTO_ROUTE_CLEARANCE : (source[1] + target[1]) / 2;
  return [source, [source[0], y], [target[0], y], target];
}

function polylineMidpoint(points) {
  var lengths = [], total = 0;
  for (var i = 0; i < points.length - 1; i++) {
    var dx = points[i + 1][0] - points[i][0], dy = points[i + 1][1] - points[i][1];
    var length = Math.sqrt(dx * dx + dy * dy); lengths.push(length); total += length;
  }
  var half = total / 2, accumulated = 0;
  for (var j = 0; j < lengths.length; j++) {
    if (accumulated + lengths[j] >= half) {
      var t = lengths[j] ? (half - accumulated) / lengths[j] : 0;
      return [points[j][0] + t * (points[j + 1][0] - points[j][0]),
        points[j][1] + t * (points[j + 1][1] - points[j][1])];
    }
    accumulated += lengths[j];
  }
  return points[points.length - 1].slice();
}

function clientToCanvas(event) {
  var rect = document.getElementById('canvas').getBoundingClientRect(), scale = canvasScale || 1;
  return [(event.clientX - rect.left) / scale, (event.clientY - rect.top) / scale];
}

function getNodeAtCanvasPoint(x, y) {
  for (var i = 0; i < NODE_IDS.length; i++) {
    var b = box('N-' + NODE_IDS[i]);
    if (x >= b.l && x <= b.r && y >= b.t && y <= b.b) return NODE_IDS[i];
  }
  return null;
}

var EDGE_SNAP_RADIUS = 14;

function computeEdgeSnap(nodeId, x, y) {
  var b = box('N-' + nodeId);
  if (x < b.l - EDGE_SNAP_RADIUS || x > b.r + EDGE_SNAP_RADIUS ||
      y < b.t - EDGE_SNAP_RADIUS || y > b.b + EDGE_SNAP_RADIUS) return null;
  var distances = [Math.abs(y - b.t), Math.abs(y - b.b), Math.abs(x - b.l), Math.abs(x - b.r)];
  var minimum = Math.min.apply(Math, distances);
  if (minimum > EDGE_SNAP_RADIUS) return null;
  if (minimum === distances[0]) { var topFx = Math.max(0, Math.min(1, (x - b.l) / b.w)); return { node: nodeId, fx: topFx, fy: 0, x: b.l + topFx * b.w, y: b.t }; }
  if (minimum === distances[1]) { var bottomFx = Math.max(0, Math.min(1, (x - b.l) / b.w)); return { node: nodeId, fx: bottomFx, fy: 1, x: b.l + bottomFx * b.w, y: b.b }; }
  if (minimum === distances[2]) { var leftFy = Math.max(0, Math.min(1, (y - b.t) / b.h)); return { node: nodeId, fx: 0, fy: leftFy, x: b.l, y: b.t + leftFy * b.h }; }
  var rightFy = Math.max(0, Math.min(1, (y - b.t) / b.h));
  return { node: nodeId, fx: 1, fy: rightFy, x: b.r, y: b.t + rightFy * b.h };
}

function lastDrawPt() {
  if (drawState.waypoints.length) return drawState.waypoints[drawState.waypoints.length - 1];
  if (drawState.startJoin) return [drawState.startJoin.x, drawState.startJoin.y];
  return resolveNodeAnchor(drawState.src);
}

function constrainSnapToOrthogonal(snap) {
  var last = lastDrawPt(), b = box('N-' + snap.node);
  if (snap.fx === 0 || snap.fx === 1) {
    var fy = (last[1] - b.t) / b.h;
    return fy < 0 || fy > 1 ? null : { node: snap.node, fx: snap.fx, fy: fy, x: snap.x, y: last[1] };
  }
  var fx = (last[0] - b.l) / b.w;
  return fx < 0 || fx > 1 ? null : { node: snap.node, fx: fx, fy: snap.fy, x: last[0], y: snap.y };
}

function findEdgeSnap(x, y) {
  var best = null, bestDistance = Infinity;
  NODE_IDS.forEach(function(nodeId) {
    if (drawState.mode === 'waypoints' && drawState.src && nodeId === drawState.src.node) return;
    var snap = computeEdgeSnap(nodeId, x, y);
    if (snap && drawState.mode === 'waypoints') snap = constrainSnapToOrthogonal(snap);
    if (!snap) return;
    var distance = Math.hypot(x - snap.x, y - snap.y);
    if (distance < bestDistance) { best = snap; bestDistance = distance; }
  });
  return best;
}

function pointToSegmentDistance(px, py, ax, ay, bx, by) {
  var dx = bx - ax, dy = by - ay, lengthSquared = dx * dx + dy * dy;
  if (!lengthSquared) return Math.hypot(px - ax, py - ay);
  var t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function connectorSnapAtPoint(x, y, tolerance, skipConnectorId) {
  var best = null;
  connectors.forEach(function(connector, connectorIndex) {
    if (connector.id === skipConnectorId) return;
    connector.edges.forEach(function(edge, edgeIndex) {
      var points = connectorEdgePoints(connector, edge), a = points[0], b = points[1];
      var dx = b[0] - a[0], dy = b[1] - a[1], lengthSquared = dx * dx + dy * dy;
      if (!lengthSquared) return;
      var t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / lengthSquared));
      var px = a[0] + t * dx, py = a[1] + t * dy, distance = Math.hypot(x - px, y - py);
      if (distance <= tolerance && (!best || distance < best.distance)) best = {
        connectorId: connector.id, edgeId: edge.id, x: px, y: py,
        isH: Math.abs(dx) >= Math.abs(dy), distance: distance,
        connectorIndex: connectorIndex, edgeIndex: edgeIndex
      };
    });
  });
  return best;
}

function findNearestSegment(x, y, tolerance) {
  var hits = [];
  connectors.forEach(function(connector, connectorIndex) {
    connector.edges.forEach(function(edge, edgeIndex) {
      var points = connectorEdgePoints(connector, edge);
      var distance = pointToSegmentDistance(x, y, points[0][0], points[0][1], points[1][0], points[1][1]);
      if (distance <= tolerance) hits.push({ connector: connector, edgeId: edge.id, points: points,
        isH: Math.abs(points[1][0] - points[0][0]) >= Math.abs(points[1][1] - points[0][1]),
        distance: distance, terminal: !!connectorTerminalForEdge(connector, edge.id),
        connectorIndex: connectorIndex, edgeIndex: edgeIndex });
    });
  });
  hits.sort(function(a, b) { return a.distance - b.distance || Number(b.terminal) - Number(a.terminal) ||
    a.connectorIndex - b.connectorIndex || a.edgeIndex - b.edgeIndex; });
  return hits[0] || null;
}

function findConnectorNearPoint(x, y, tolerance) {
  var hit = findNearestSegment(x, y, tolerance);
  return hit ? hit.connector : null;
}

function svgElement(name, attributes) {
  var element = document.createElementNS('http://www.w3.org/2000/svg', name);
  Object.keys(attributes || {}).forEach(function(key) { element.setAttribute(key, attributes[key]); });
  return element;
}

function tagEditorOverlay(element) {
  element.setAttribute('data-editor-overlay', 'true');
  return element;
}

function connectorPathElement(points, color, marker, dashed) {
  var pathData = 'M' + points[0][0] + ',' + points[0][1];
  for (var i = 1; i < points.length; i++) pathData += ' L' + points[i][0] + ',' + points[i][1];
  var path = svgElement('path', { d: pathData, fill: 'none', stroke: color,
    'stroke-width': 1.4, 'pointer-events': 'none' });
  if (marker) path.setAttribute('marker-end', 'url(#' + marker + ')');
  if (dashed) path.setAttribute('stroke-dasharray', '5,3');
  return path;
}

function drawConnectorGlow(connector, opacity) {
  var svg = document.getElementById('svgl');
  connector.edges.forEach(function(edge) {
    var path = connectorPathElement(connectorEdgePoints(connector, edge), connector.style.color, null, false);
    path.setAttribute('stroke-width', 10); path.setAttribute('stroke-opacity', opacity);
    path.setAttribute('stroke-linecap', 'round'); tagEditorOverlay(path); svg.appendChild(path);
  });
}

function renderConnectorHandles() {
  var connector = findConnectorById(selectedConnectorId);
  if (!connector) return;
  var svg = document.getElementById('svgl');
  Object.keys(connector.vertices).forEach(function(vertexId) {
    var vertex = connector.vertices[vertexId], degree = connectorEdgesAt(connector, vertexId).length;
    if (vertex.kind === 'point' && degree === 2) {
      var bend = tagEditorOverlay(svgElement('circle', { cx: vertex.x, cy: vertex.y, r: 7,
        fill: '#ed7d31', stroke: '#fff', 'stroke-width': 2 }));
      bend.style.cursor = 'grab';
      bend.addEventListener('mousedown', function(event) {
        event.stopPropagation(); event.preventDefault();
        draggingWaypoint = { connectorId: connector.id, vertexId: vertexId, startX: event.clientX,
          startY: event.clientY, edgeId: null, moved: false };
      });
      svg.appendChild(bend);
    }
    if (vertex.kind === 'anchor' && (vertexId === connector.source || connectorTerminalForVertex(connector, vertexId))) {
      var point = resolveConnectorVertexPoint(connector, vertexId);
      var endpoint = tagEditorOverlay(svgElement('circle', { cx: point[0], cy: point[1], r: 6,
        fill: '#3b7dd8', stroke: '#fff', 'stroke-width': 2 }));
      endpoint.style.cursor = 'crosshair'; endpoint.style.pointerEvents = 'all';
      endpoint.addEventListener('mousedown', function(event) {
        event.stopPropagation(); event.preventDefault();
        endpointDrag = { active: true, connectorId: connector.id, vertexId: vertexId,
          origAnchor: cloneConnectorValue(vertex), edgeSnap: null, connectorSnap: null, moved: false };
      });
      svg.appendChild(endpoint);
    }
  });
}

function renderSnapDots() {
  var svg = document.getElementById('svgl');
  if (drawState.connectorSnap) {
    var connector = findConnectorById(drawState.connectorSnap.connectorId);
    if (connector) drawConnectorGlow(connector, 0.35);
    svg.appendChild(tagEditorOverlay(svgElement('circle', { cx: drawState.connectorSnap.x,
      cy: drawState.connectorSnap.y, r: 6, fill: '#ed7d31', stroke: '#fff',
      'stroke-width': 2, 'pointer-events': 'none' })));
  }
  if (!drawState.edgeSnap) return;
  var b = box('N-' + drawState.edgeSnap.node);
  svg.appendChild(tagEditorOverlay(svgElement('rect', { x: b.l - 1, y: b.t - 1,
    width: b.w + 2, height: b.h + 2, fill: 'none', stroke: '#3b7dd8',
    'stroke-width': 1.5, 'stroke-dasharray': '4,3', 'pointer-events': 'none' })));
  svg.appendChild(tagEditorOverlay(svgElement('circle', { cx: drawState.edgeSnap.x,
    cy: drawState.edgeSnap.y, r: 6, fill: '#3b7dd8', stroke: '#fff',
    'stroke-width': 2, 'pointer-events': 'none' })));
}

function renderPreviewLine() {
  if (drawState.mode !== 'waypoints') return;
  var start = drawState.startJoin ? [drawState.startJoin.x, drawState.startJoin.y] : resolveNodeAnchor(drawState.src);
  var points = [start].concat(drawState.waypoints.map(function(point) { return point.slice(); }));
  var last = points[points.length - 1];
  var cursor = drawState.edgeSnap ? [drawState.edgeSnap.x, drawState.edgeSnap.y]
    : Math.abs(drawState.cursorPt[0] - last[0]) >= Math.abs(drawState.cursorPt[1] - last[1])
      ? [drawState.cursorPt[0], last[1]] : [last[0], drawState.cursorPt[1]];
  points.push(cursor);
  var preview = connectorPathElement(points, '#aaa', null, true);
  tagEditorOverlay(preview); document.getElementById('svgl').appendChild(preview);
}

function drawArrows() {
  var svg = document.getElementById('svgl');
  connectors.forEach(function(connector) {
    if (connector.id === selectedConnectorId) drawConnectorGlow(connector, 0.45);
    else if (connector.id === hoveredConnectorId) drawConnectorGlow(connector, 0.25);
    var group = svgElement('g', { 'data-connector-id': connector.id });
    connector.edges.forEach(function(edge) {
      group.appendChild(connectorPathElement(connectorEdgePoints(connector, edge), connector.style.color,
        connectorTerminalMarker(connector, edge.id), connector.style.dashed));
    });
    svg.appendChild(group);
    connector.terminals.forEach(function(terminal) {
      if (!terminal.label || !terminal.label.text) return;
      var route = connectorRoutePoints(connector, terminal), midpoint = polylineMidpoint(route);
      lbl(midpoint[0], midpoint[1] - 8, terminal.label.text, connector.style.color,
        'middle', null, terminal.label.key);
      var labelGroup = svg.lastChild;
      if (labelGroup && labelGroup.tagName && labelGroup.tagName.toLowerCase() === 'g') group.appendChild(labelGroup);
    });
  });
  if (drawState.mode !== 'idle' && drawState.mode !== 'palette') { renderSnapDots(); renderPreviewLine(); }
  if (drawState.mode === 'palette' && drawState.dst) {
    var start = drawState.startJoin ? [drawState.startJoin.x, drawState.startJoin.y] : resolveNodeAnchor(drawState.src);
    var previewPoints = [start].concat(drawState.waypoints).concat([resolveNodeAnchor(drawState.dst)]);
    var startConnector = drawState.startConnectorId && findConnectorById(drawState.startConnectorId);
    var previewStyle = startConnector ? startConnector.style : { color: paletteSelectedColor.hex, dashed: false };
    var previewPath = connectorPathElement(previewPoints, previewStyle.color,
      startConnector && startConnector.terminals[0] ? startConnector.terminals[0].marker : paletteSelectedColor.marker,
      previewStyle.dashed);
    tagEditorOverlay(previewPath); svg.appendChild(previewPath);
  }
  if (selectedConnectorId) renderConnectorHandles();
  if (rubberBand.active) {
    var canvasRect = document.getElementById('canvas').getBoundingClientRect(), scale = canvasScale || 1;
    svg.appendChild(tagEditorOverlay(svgElement('rect', {
      x: (Math.min(rubberBand.startX, rubberBand.curX) - canvasRect.left) / scale,
      y: (Math.min(rubberBand.startY, rubberBand.curY) - canvasRect.top) / scale,
      width: Math.abs(rubberBand.curX - rubberBand.startX) / scale,
      height: Math.abs(rubberBand.curY - rubberBand.startY) / scale,
      fill: 'rgba(59,125,216,0.06)', stroke: '#3b7dd8', 'stroke-width': 1,
      'stroke-dasharray': '4,3', 'pointer-events': 'none'
    })));
  }
}

function connectorFromDraw(sourceAnchor, targetAnchor, waypoints, style, terminalData) {
  var id = 'connector_' + Date.now(), sourceId = 'v_source', targetId = 'v_terminal';
  var connector = { id: id, kind: 'tree', source: sourceId, vertices: {}, edges: [],
    terminals: [], style: { color: style.color, dashed: !!style.dashed } };
  connector.vertices[sourceId] = Object.assign({ kind: 'anchor' }, cloneConnectorValue(sourceAnchor));
  var previous = sourceId;
  waypoints.forEach(function(point, index) {
    var pointId = 'v_point_' + (index + 1);
    connector.vertices[pointId] = { kind: 'point', x: point[0], y: point[1] };
    connector.edges.push({ id: 'e_' + (index + 1), from: previous, to: pointId });
    previous = pointId;
  });
  connector.vertices[targetId] = Object.assign({ kind: 'anchor' }, cloneConnectorValue(targetAnchor));
  connector.edges.push({ id: 'e_' + (waypoints.length + 1), from: previous, to: targetId });
  connector.terminals.push({ vertex: targetId, marker: terminalData.marker,
    label: { text: terminalData.text, key: id + '_lbl' } });
  normalizeConnector(connector, 0.01);
  return connector;
}

function handleSnapDotClick(node, fx, fy) {
  if (drawState.mode === 'src') {
    drawState.src = { kind: 'anchor', node: node, fx: fx, fy: fy };
    drawState.mode = 'waypoints';
    setDrawHint('Click canvas for waypoints · Click target snap point to finish · Backspace = undo · Esc = cancel');
  } else if (drawState.mode === 'waypoints') {
    if (drawState.src && node === drawState.src.node) return;
    drawState.dst = { kind: 'anchor', node: node, fx: fx, fy: fy };
    drawState.mode = 'palette'; setDrawHint(null); showPalette();
  }
  clearSVG(); drawArrows();
}

function handleConnectorSnapClick(snap) {
  drawState.startConnectorId = snap.connectorId;
  drawState.startEdgeId = snap.edgeId;
  drawState.startJoin = { x: snap.x, y: snap.y, isH: snap.isH };
  drawState.connectorSnap = null; drawState.mode = 'waypoints';
  setDrawHint('Branching from a connector · Click canvas for waypoints · Click target snap point to finish · Backspace = undo · Esc = cancel');
  clearSVG(); drawArrows();
}

function setDrawHint(text) {
  var hint = document.getElementById('draw-hint'), span = document.getElementById('draw-hint-text');
  if (!hint) return;
  if (text) { hint.style.display = 'block'; span.textContent = text; }
  else hint.style.display = 'none';
}

function emptyDrawState(mode) {
  return { mode: mode || 'idle', src: null, dst: null, waypoints: [], cursorPt: [0, 0],
    hoveredNode: null, edgeSnap: null, connectorSnap: null, startConnectorId: null,
    startEdgeId: null, startJoin: null };
}

function startDrawMode() {
  setSelectedConnector(null); hoveredConnectorId = null; hoveredEdgeId = null;
  segDrag.active = false; segDrag.moved = false; drawState = emptyDrawState('src');
  document.body.classList.add('drawing-mode');
  setDrawHint('Click a source node snap point, or click an existing connector to add a branch · Esc to cancel');
  clearSVG(); drawArrows();
}

function cancelDraw() {
  drawState = emptyDrawState('idle'); document.body.classList.remove('drawing-mode');
  hidePalette(); setDrawHint(null); clearSVG(); drawArrows();
}

function confirmArrow() {
  var labelText = document.getElementById('palette-label').value;
  var isDashed = document.getElementById('palette-dashed').checked;
  pushUndo();
  if (drawState.startConnectorId) {
    var connector = findConnectorById(drawState.startConnectorId);
    if (!connector) { cancelDraw(); return; }
    var join = splitConnectorEdge(connector, drawState.startEdgeId,
      { x: drawState.startJoin.x, y: drawState.startJoin.y }, CONNECTOR_JOIN_EPSILON,
      function(anchor) { return resolveNodeAnchor(anchor); });
    var route = drawState.waypoints.map(function(point) { return point.slice(); });
    var joinPoint = resolveConnectorVertexPoint(connector, join.vertexId);
    if (route.length) {
      if (drawState.startJoin.isH) route[0][0] = joinPoint[0];
      else route[0][1] = joinPoint[1];
    }
    var marker = connector.terminals[0] ? connector.terminals[0].marker : paletteSelectedColor.marker;
    addConnectorTerminal(connector, join, route, drawState.dst,
      { marker: marker, label: { text: labelText, key: connector.id + '_terminal_' + Date.now() + '_lbl' } });
    normalizeConnector(connector, CONNECTOR_JOIN_EPSILON);
  } else {
    connectors.push(connectorFromDraw(drawState.src, drawState.dst, drawState.waypoints,
      { color: paletteSelectedColor.hex, dashed: isDashed },
      { marker: paletteSelectedColor.marker, text: labelText }));
  }
  saveConnectors(); cancelDraw();
}

function deleteSelectedArrow() {
  if (!selectedConnectorId) return;
  pushUndo();
  var connector = findConnectorById(selectedConnectorId);
  if (connector) connector.terminals.forEach(function(terminal) {
    if (terminal.label && terminal.label.key) delete labelPositions[terminal.label.key];
  });
  connectors = connectors.filter(function(item) { return item.id !== selectedConnectorId; });
  setSelectedConnector(null); saveConnectors(); saveLabelPositions(); clearSVG(); drawArrows();
}

function isInsideNode(element) {
  while (element) {
    if (element.classList && element.classList.contains('node')) return true;
    element = element.parentElement;
  }
  return false;
}

function handleCanvasClick(event) {
  if (READONLY) return;
  if (segDragJustFinished) { segDragJustFinished = false; return; }
  if (rubberBandJustFinished) { rubberBandJustFinished = false; return; }
  if (drawState.mode === 'idle') {
    if (isInsideNode(event.target)) return;
    var point = clientToCanvas(event);
    var connector = findConnectorNearPoint(point[0], point[1], 8 / (canvasScale || 1));
    setSelectedConnector(connector ? connector.id : null); hideLabelEdit();
    if (!connector) clearNodeSelection();
    clearSVG(); drawArrows();
  } else if (drawState.mode === 'src') {
    if (drawState.connectorSnap) handleConnectorSnapClick(drawState.connectorSnap);
    else if (drawState.edgeSnap) handleSnapDotClick(drawState.edgeSnap.node, drawState.edgeSnap.fx, drawState.edgeSnap.fy);
  } else if (drawState.mode === 'waypoints') {
    if (drawState.edgeSnap) {
      handleSnapDotClick(drawState.edgeSnap.node, drawState.edgeSnap.fx, drawState.edgeSnap.fy); return;
    }
    var raw = clientToCanvas(event), last = lastDrawPt();
    drawState.waypoints.push(Math.abs(raw[0] - last[0]) >= Math.abs(raw[1] - last[1])
      ? [raw[0], last[1]] : [last[0], raw[1]]);
    clearSVG(); drawArrows();
  }
}

function buildColorSwatches() {
  var container = document.getElementById('palette-colors');
  if (!container) return;
  ARROW_COLORS.forEach(function(color, index) {
    var swatch = document.createElement('div'); swatch.title = color.name;
    swatch.style.cssText = 'width:26px;height:26px;border-radius:50%;cursor:pointer;background:' + color.hex +
      ';border:3px solid ' + (index === 0 ? '#333' : 'transparent') + ';flex-shrink:0;';
    swatch.addEventListener('click', function() {
      container.querySelectorAll('div').forEach(function(item) { item.style.borderColor = 'transparent'; });
      swatch.style.borderColor = '#333'; paletteSelectedColor = color;
    });
    container.appendChild(swatch);
  });
}

function wirePaletteButtons() {
  var confirm = document.getElementById('palette-confirm'), cancel = document.getElementById('palette-cancel');
  if (confirm) confirm.addEventListener('click', confirmArrow);
  if (cancel) cancel.addEventListener('click', cancelDraw);
}

function showPalette() {
  var palette = document.getElementById('arrow-palette');
  if (palette) palette.style.display = 'block';
  var label = document.getElementById('palette-label');
  if (label) { label.value = ''; label.focus(); }
}

function hidePalette() {
  var palette = document.getElementById('arrow-palette');
  if (palette) palette.style.display = 'none';
}

function connectorCollinearRun(connector, edgeId) {
  var start = connectorEdgeById(connector, edgeId);
  if (!start) return [];
  var startPoints = connectorEdgePoints(connector, start);
  var horizontal = Math.abs(startPoints[1][0] - startPoints[0][0]) >= Math.abs(startPoints[1][1] - startPoints[0][1]);
  var coordinate = horizontal ? startPoints[0][1] : startPoints[0][0];
  var run = {}, frontier = [start.from, start.to]; run[start.id] = true;
  while (frontier.length) {
    var vertexId = frontier.pop();
    connectorEdgesAt(connector, vertexId).forEach(function(edge) {
      if (run[edge.id]) return;
      var points = connectorEdgePoints(connector, edge);
      var edgeHorizontal = Math.abs(points[1][0] - points[0][0]) >= Math.abs(points[1][1] - points[0][1]);
      var edgeCoordinate = edgeHorizontal ? points[0][1] : points[0][0];
      if (edgeHorizontal === horizontal && Math.abs(edgeCoordinate - coordinate) < 0.01) {
        run[edge.id] = true; frontier.push(edge.from === vertexId ? edge.to : edge.from);
      }
    });
  }
  return Object.keys(run);
}

function applySegmentDrag(dx, dy) {
  var connector = findConnectorById(segDrag.connectorId);
  if (!connector || !segDrag.origConnector) return;
  connector.vertices = cloneConnectorValue(segDrag.origConnector.vertices);
  connector.edges = cloneConnectorValue(segDrag.origConnector.edges);
  connector.terminals = cloneConnectorValue(segDrag.origConnector.terminals);
  connector.style = cloneConnectorValue(segDrag.origConnector.style);
  var run = connectorCollinearRun(connector, segDrag.edgeId), delta = segDrag.isH ? dy : dx, movedVertices = {};
  run.forEach(function(edgeId) {
    var edge = connectorEdgeById(connector, edgeId); movedVertices[edge.from] = true; movedVertices[edge.to] = true;
  });
  Object.keys(movedVertices).forEach(function(vertexId) {
    var vertex = connector.vertices[vertexId];
    if (vertex.kind === 'point') {
      if (segDrag.isH) vertex.y += delta; else vertex.x += delta;
    } else {
      var b = box('N-' + vertex.node), point = resolveNodeAnchor(vertex);
      if (segDrag.isH && (vertex.fx === 0 || vertex.fx === 1))
        vertex.fy = Math.max(0, Math.min(1, (point[1] + delta - b.t) / b.h));
      if (!segDrag.isH && (vertex.fy === 0 || vertex.fy === 1))
        vertex.fx = Math.max(0, Math.min(1, (point[0] + delta - b.l) / b.w));
    }
  });
  connector.terminals.forEach(function(terminal) {
    var key = terminal.label && terminal.label.key, original = key && segDrag.origLabelPositions[key];
    var path = connectorPathToTerminal(connector, terminal.vertex);
    if (original && path.edgeIds.some(function(runEdgeId) { return run.indexOf(runEdgeId) >= 0; })) {
      labelPositions[key] = { x: original.x + (segDrag.isH ? 0 : delta),
        y: original.y + (segDrag.isH ? delta : 0), r: original.r };
    }
  });
}

function populateBoxes() {
  NODE_IDS.forEach(function(id) {
    var data = DATA[id], element = document.getElementById('N-' + id);
    if (!data || !element) return;
    element.querySelector('.ntitle').textContent = data.title;
    element.querySelector('.badge').textContent = data.badge;
    element.querySelector('.nsub').innerHTML = data.nsub || '';
  });
}

'use strict';

// Read visible connector geometry in SVG coordinates. Shared inheritance
// fans draw lines instead of polylines; follow their painted segments from
// the marked parent attachment to each child, splitting at junctions. Child
// endpoints need not be graph leaves when two painted branches overlap.
function readRenderedRoutes() {
  const svg = document.querySelector('#diagram svg');
  const toSvg = svg.getScreenCTM().inverse();
  const transform = (element, point) => {
    const converted = new DOMPoint(point.x, point.y).matrixTransform(toSvg.multiply(element.getScreenCTM()));
    return { x: converted.x, y: converted.y };
  };
  const routes = [...svg.querySelectorAll('polyline[data-layout-route-id], polyline.uml-class-hierarchy-route')]
    .map(element => ({
      id: element.getAttribute('data-layout-route-id'),
      source: element.getAttribute('data-layout-source'),
      target: element.getAttribute('data-layout-target'),
      points: [...element.points].map(point => transform(element, point)),
    }));
  const keyOf = point => `${point.x.toFixed(4)},${point.y.toFixed(4)}`;
  const straight = (a, b, c) => Math.abs((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)) < 1e-6;

  for (const group of svg.querySelectorAll('[data-uml-hierarchy]')) {
    const [rootX, rootY] = group.getAttribute('data-uml-hierarchy-root').split(',').map(Number);
    const root = transform(group, { x: rootX, y: rootY });
    const segments = [...group.querySelectorAll('line')].map(line => [
      transform(line, { x: line.x1.baseVal.value, y: line.y1.baseVal.value }),
      transform(line, { x: line.x2.baseVal.value, y: line.y2.baseVal.value }),
    ]);
    const children = new Map();
    for (const line of group.querySelectorAll('line[data-uml-hierarchy-child]')) {
      const endpoint = transform(line, { x: line.x2.baseVal.value, y: line.y2.baseVal.value });
      const key = keyOf(endpoint);
      if (!children.has(key)) children.set(key, []);
      children.get(key).push(line.getAttribute('data-uml-hierarchy-child'));
    }
    const vertices = new Map([root, ...segments.flat()].map(point => [keyOf(point), point]));
    const neighbors = new Map([...vertices.keys()].map(key => [key, new Set()]));
    for (const [start, end] of segments) {
      const onSegment = [...vertices.values()].filter(point => straight(start, point, end)
        && point.x >= Math.min(start.x, end.x) - 1e-6 && point.x <= Math.max(start.x, end.x) + 1e-6
        && point.y >= Math.min(start.y, end.y) - 1e-6 && point.y <= Math.max(start.y, end.y) + 1e-6);
      onSegment.sort((a, b) => Math.abs(a.x - start.x) + Math.abs(a.y - start.y)
        - Math.abs(b.x - start.x) - Math.abs(b.y - start.y));
      for (let index = 1; index < onSegment.length; index++) {
        const from = keyOf(onSegment[index - 1]), to = keyOf(onSegment[index]);
        neighbors.get(from).add(to);
        neighbors.get(to).add(from);
      }
    }
    const pending = [[keyOf(root)]];
    while (pending.length) {
      const path = pending.pop();
      const last = path[path.length - 1];
      if (children.has(last) && path.length > 1) {
        const points = path.map(key => vertices.get(key));
        for (const child of children.get(last)) routes.push({
          id: `hierarchy:${group.getAttribute('data-uml-hierarchy')}:${child}`,
          source: null,
          target: null,
          points: points.filter((point, index) => index === 0 || index === points.length - 1
            || !straight(points[index - 1], point, points[index + 1])),
        });
      }
      const next = [...neighbors.get(last)].filter(key => !path.includes(key));
      next.forEach(key => pending.push([...path, key]));
    }
  }
  return routes;
}

module.exports = { readRenderedRoutes };

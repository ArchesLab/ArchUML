'use strict';

// Opens Chromium pages with the ArchUML bundle loaded and installs
// measurements of the rendered SVG as a reader sees it: text boxes and font
// faces, element rectangles, package frames, and connector routes. Every
// measurement uses the shared user space of the diagram's content group.
const path = require('node:path');
const { chromium } = require('playwright');

const BUNDLE = path.join(__dirname, '../../uml-bundle.js');

function launchBrowser() {
  const executablePath = process.env.PLAYWRIGHT_CHROME_EXECUTABLE;
  return chromium.launch(executablePath ? { executablePath } : {});
}

function installMeasurements() {
  const plainBox = (element) => {
    const b = element.getBBox();
    return { x: b.x, y: b.y, width: b.width, height: b.height, right: b.x + b.width, bottom: b.y + b.height };
  };
  const svg = () => document.querySelector('#diagram svg');
  window.measure = {
    box: plainBox,
    texts() {
      return [...svg().querySelectorAll('text')].map((text) => {
        const style = getComputedStyle(text);
        return {
          text: text.textContent,
          anchor: text.getAttribute('text-anchor') || 'start',
          bold: Number(style.fontWeight) >= 600,
          italic: style.fontStyle === 'italic',
          layoutId: text.getAttribute('data-layout-id'),
          ...plainBox(text),
        };
      });
    },
    text(content) {
      return this.texts().find((text) => text.text === content) || null;
    },
    componentBox(id) {
      const rect = [...svg().querySelectorAll('rect.uml-component-box')].find((el) => el.getAttribute('data-layout-id') === id);
      return rect ? plainBox(rect) : null;
    },
    componentIds() {
      return [...svg().querySelectorAll('rect.uml-component-box')].map((el) => el.getAttribute('data-layout-id'));
    },
    classBox(id) {
      const rect = [...svg().querySelectorAll('rect[data-layout-bounds-id]')].find((el) => el.getAttribute('data-layout-bounds-id') === id);
      return rect ? plainBox(rect) : null;
    },
    ports() {
      return [...svg().querySelectorAll('rect[data-layout-kind="port"]')].map((el) => ({
        id: el.getAttribute('data-layout-id'), parent: el.getAttribute('data-layout-parent'), ...plainBox(el),
      }));
    },
    routes() {
      return [...svg().querySelectorAll('[data-layout-route-id]')].filter((el) => el.points).map((el) => ({
        source: el.getAttribute('data-layout-source'),
        target: el.getAttribute('data-layout-target'),
        dashed: !!el.getAttribute('stroke-dasharray'),
        points: [...el.points].map(({ x, y }) => ({ x, y })),
      }));
    },
    // A UML package: its body rectangle, its tab, and the name in the tab,
    // which is drawn in a later layer.
    packages() {
      return [...svg().querySelectorAll('g[data-uml-package]')].map((group) => {
        const id = group.getAttribute('data-uml-package');
        const body = group.querySelector('[data-package-part="body"]');
        const tab = group.querySelector('[data-package-part="tab"]');
        const names = [...svg().querySelectorAll('g[data-uml-package-name]')].find((el) => el.getAttribute('data-uml-package-name') === id);
        return {
          id,
          body: plainBox(body),
          tab: plainBox(tab),
          dashed: !!(body.getAttribute('stroke-dasharray') || tab.getAttribute('stroke-dasharray')),
          fill: body.getAttribute('fill'),
          // Elements that are not members but overlap the package.
          overlaps: (group.getAttribute('data-package-overlaps') || '').split(' ').filter(Boolean),
          pointerEvents: getComputedStyle(group).pointerEvents,
          labels: (names ? [...names.querySelectorAll('text')] : []).map((text) => ({
            text: text.textContent, bold: Number(getComputedStyle(text).fontWeight) >= 600, ...plainBox(text),
          })),
        };
      });
    },
    // Index of an element in drawing order (later elements paint on top).
    paintOrder(element) {
      return [...svg().querySelectorAll('*')].indexOf(element);
    },
  };
}

async function openDiagramPage(browser, { theme = 'light' } = {}) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.setContent('<!doctype html><html lang="en"' + (theme === 'dark' ? ' class="dark-mode"' : '') +
    '><head><title>ArchUML rendering check</title></head><body><div id="diagram"></div></body></html>');
  await page.addScriptTag({ path: BUNDLE });
  await page.evaluate(installMeasurements);
  return page;
}

// Render `source` with the named renderer (`UMLComponentDiagram`, ...).
async function render(page, renderer, source) {
  await page.evaluate(({ renderer, source }) => {
    window[renderer].render(document.getElementById('diagram'), source);
  }, { renderer, source });
}

function overlaps(a, b, pad = 0) {
  return a.x < b.right + pad && b.x < a.right + pad && a.y < b.bottom + pad && b.y < a.bottom + pad;
}

function contains(outer, inner, pad = 0) {
  return inner.x >= outer.x + pad && inner.right <= outer.right - pad &&
    inner.y >= outer.y + pad && inner.bottom <= outer.bottom - pad;
}

module.exports = { launchBrowser, openDiagramPage, render, overlaps, contains };

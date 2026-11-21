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

/**
 * Pixels in a page region that differ from its most common color, as a
 * reader sees them; `hide` names elements left out of the picture.
 */
async function inkPixels(page, clip, hide) {
  const png = await page.screenshot({ fullPage: true, clip, style: hide ? `${hide} { visibility: hidden !important; }` : '' });
  return page.evaluate(async (base64) => {
    const image = new Image();
    image.src = 'data:image/png;base64,' + base64;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    const { data } = context.getImageData(0, 0, image.width, image.height);
    const counts = new Map();
    for (let i = 0; i < data.length; i += 4) {
      const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    const background = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const channel = (key, shift) => (key >> shift) & 255;
    let ink = 0;
    for (let i = 0; i < data.length; i += 4) {
      const distance = Math.max(Math.abs(data[i] - channel(background, 16)),
        Math.abs(data[i + 1] - channel(background, 8)), Math.abs(data[i + 2] - channel(background, 0)));
      if (distance > 24) ink += 1;
    }
    return ink;
  }, png.toString('base64'));
}

module.exports = { launchBrowser, openDiagramPage, render, overlaps, contains, inkPixels };

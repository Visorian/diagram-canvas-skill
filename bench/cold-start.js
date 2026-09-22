// Cold-start benchmark for playwright-cli. Build both variants and serve them first:
//   bun run build && bun run build:vdom
//   vite preview --port 4301 --outDir dist & vite preview --port 4302 --outDir dist-vdom &
//   playwright-cli run-code --filename=bench/cold-start.js
async (page) => {
  const variants = { vapor: "http://localhost:4301/", vdom: "http://localhost:4302/" };
  const cpuRates = [1, 4];
  const runs = 30;

  // Records when the diagram is fully on screen: all nodes measured, all edges drawn, fit-view applied.
  const readyProbe = () => {
    const observer = new MutationObserver(() => {
      const nodes = document.querySelectorAll(".vue-flow__node");
      const measured = [...nodes].filter((node) => node.getBoundingClientRect().width > 0);
      const edges = document.querySelectorAll(".vue-flow__edge path");
      const pane = document.querySelector(".vue-flow__transformationpane");
      const fitted = pane && pane.style.transform && !pane.style.transform.endsWith("scale(1)");
      if (nodes.length === 6 && measured.length === 6 && edges.length >= 6 && fitted) {
        window.readyAt = performance.now();
        observer.disconnect();
      }
    });
    observer.observe(document, { subtree: true, childList: true, attributes: true });
  };

  const browser = page.context().browser();
  const measure = async (url, cpuRate) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const tab = await context.newPage();
    const cdp = await context.newCDPSession(tab);
    await cdp.send("Performance.enable");
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpuRate });
    await tab.addInitScript(readyProbe);
    await tab.goto(url);
    await tab.waitForFunction(() => window.readyAt !== undefined);
    const timing = await tab.evaluate(async () => ({
      fcp: await new Promise((resolve) => {
        new PerformanceObserver((list) => resolve(list.getEntries()[0].startTime)).observe({
          type: "paint",
          buffered: true,
        });
      }),
      ready: window.readyAt,
    }));
    const { metrics } = await cdp.send("Performance.getMetrics");
    const metric = (name) => metrics.find((entry) => entry.name === name).value;
    await context.close();
    return {
      ...timing,
      script: metric("ScriptDuration") * 1000,
      heap: metric("JSHeapUsedSize") / 1024 / 1024,
    };
  };

  const quantile = (values, q) => {
    const sorted = values.toSorted((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  };

  const results = [];
  for (const cpuRate of cpuRates) {
    const samples = { vapor: [], vdom: [] };
    for (const url of Object.values(variants)) await measure(url, cpuRate);
    for (let run = 0; run < runs; run++) {
      const order = run % 2 ? ["vdom", "vapor"] : ["vapor", "vdom"];
      for (const name of order) samples[name].push(await measure(variants[name], cpuRate));
    }
    for (const [name, list] of Object.entries(samples)) {
      const row = { cpu: `${cpuRate}x`, variant: name };
      for (const key of ["fcp", "ready", "script", "heap"]) {
        const values = list.map((sample) => sample[key]);
        row[`${key} p50`] = Number(quantile(values, 0.5).toFixed(key === "heap" ? 2 : 1));
        row[`${key} p90`] = Number(quantile(values, 0.9).toFixed(key === "heap" ? 2 : 1));
      }
      results.push(row);
    }
  }
  return JSON.stringify(results);
}

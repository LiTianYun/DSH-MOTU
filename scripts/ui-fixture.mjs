/** Isolated HTTP fixture using the real host routes and browser half. */
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { apply, Config, mergeConfigPatch } from '../lib/index.js'

export const chartSamples = {
  bar: { title: { text: '交互柱状图' }, tooltip: { trigger: 'item' }, legend: { data: ['销量', '目标'] },
    xAxis: { type: 'category', data: ['一月', '二月', '三月'] }, yAxis: {},
    series: [{ name: '销量', type: 'bar', data: [5, 8, 6] }, { name: '目标', type: 'bar', data: [6, 6, 6] }] },
  line: { title: { text: '交互折线图' }, tooltip: { trigger: 'item' }, legend: { data: ['趋势'] },
    xAxis: { type: 'category', data: Array.from({ length: 20 }, (_, i) => `${i + 1}日`) }, yAxis: {},
    dataZoom: [{ type: 'inside', start: 0, end: 100 }, { type: 'slider', start: 0, end: 100 }],
    series: [{ name: '趋势', type: 'line', data: Array.from({ length: 20 }, (_, i) => 3 + i % 7) }] },
  pie: { title: { text: '交互饼图' }, tooltip: { trigger: 'item' }, legend: { data: ['开发', '测试'] },
    series: [{ name: '工时', type: 'pie', radius: ['30%', '65%'], data: [{ name: '开发', value: 60 }, { name: '测试', value: 40 }] }] },
}

export async function startUiFixture() {
  const routes = new Map()
  let config = Config({ behavior: { lazyRender: false, debounceMs: 30, selfRepair: false } })
  let dispose
  const ctx = {
    webServer: { register(route) { routes.set(`${route.kind}:${route.path}`, route); return () => routes.delete(`${route.kind}:${route.path}`) } },
    get(name) { return name === 'configEditor' ? {
      entries: () => [{ name: 'dsh-visual-kit' }],
      async edit(_entry, change) { config = Config(mergeConfigPatch(config, change(config))); dispose(); dispose = apply(ctx, config) },
    } : undefined },
  }
  dispose = apply(ctx, config)
  const clientPath = fileURLToPath(new URL('../lib/client.js', import.meta.url))
  const html = `<!doctype html><html data-theme="light"><meta charset="utf-8"><title>墨图交互验收</title>
<style>*{box-sizing:border-box}body{margin:0;color:#444441;background:#f8f7f3;font:14px/1.6 system-ui,'Microsoft YaHei',sans-serif}main{max-width:1000px;margin:auto;padding:24px}pre{overflow:auto}html[data-theme=dark] body{color:#e7e5dd;background:#242420}h1{font-size:24px}section{min-width:0}@media(max-width:600px){main{padding:12px}}</style>
<main><h1>墨图 · 交互展示验收</h1><div id="chat"></div></main>
<script>
window.__ModuleLoader__={load({factory}){window.motu=factory(()=>({createElement(){},useState(v){return[v,()=>{}]},useRef(v){return{current:v}},useEffect(){},useCallback(f){return f}}))}};
window.addBlock=(id,language,source,hidden=false)=>{
 const wrapper=document.createElement('section');wrapper.id=id;if(hidden)wrapper.style.display='none';
 const pre=document.createElement('pre');const code=document.createElement('code');code.className='language-'+language;code.textContent=source;
 pre.append(code);wrapper.append(pre);document.querySelector('#chat').append(wrapper);return wrapper;
};
</script><script src="/client.js"></script><script>
window.ready=(async()=>{
 const cleanups=[];motu.apply({effect(fn){cleanups.push(fn())},get(){}});window.stopMotu=()=>cleanups.forEach(fn=>fn?.());
 motu.internals.SessionProbe({sessionId:'fixture-session'});
 const catalogue=await(await fetch('/dsh-visual-kit/renderers.json')).json();
 if(!new URL(location.href).searchParams.has('onlyLive'))for(const spec of catalogue.renderers)addBlock('static-'+spec.id,spec.languages[0],spec.sample);
 const samples=await(await fetch('/samples.json')).json();for(const [id,option]of Object.entries(samples))addBlock('live-'+id,'echarts-interactive',JSON.stringify(option));
})();
</script></html>`
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname
    if (path === '/') { res.setHeader('content-type', 'text/html;charset=utf-8'); res.end(html); return }
    if (path === '/client.js') { res.setHeader('content-type', 'text/javascript'); res.end(readFileSync(clientPath)); return }
    if (path === '/samples.json') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(chartSamples)); return }
    if (path === '/favicon.ico') { res.end(); return }
    const route = [...routes.values()].find(route => route.kind === 'exact' ? route.path === path : path.startsWith(route.path))
    if (!route) { res.statusCode = 404; res.end(); return }
    route.handler(req, res)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${server.address().port}`, async close() { dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) } }
}

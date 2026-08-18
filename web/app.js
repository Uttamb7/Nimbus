const $ = (selector) => document.querySelector(selector);
const endpoint = "/graphql";
const positions = { gateway:[90,205], "identity-api":[315,95], "order-orchestrator":[315,285], "inventory-api":[565,205], "payment-worker":[735,105], "notification-router":[735,215], "analytics-ingestor":[735,325] };
let state = { services:[], serviceGraph:[], incidents:[], auditLog:[], systemHealth:{} };
let selected = "gateway";

async function graphql(query, variables) {
  const response = await fetch(endpoint, { method:"POST", headers:{ "content-type":"application/json", authorization:"Bearer local-admin" }, body:JSON.stringify({ query, variables }) });
  const result = await response.json();
  if (result.errors) throw new Error(result.errors[0].message);
  return result.data;
}

const query = `{ systemHealth { status healthy degraded critical unknown } services { name version owner runtime health slo metrics { requestCount requestRate errorRate p50LatencyMs p95LatencyMs p99LatencyMs availability sloCompliance errorBudgetRemaining } } serviceGraph { source destination protocol requestCount errorCount averageLatencyMs lastObserved } incidents { id severity status title suspectedService affectedServices triggerCondition createdAt acknowledgedAt resolvedAt } auditLog { id timestamp actor action resource resourceId metadata } }`;
const fmt = (value, digits=1) => Number(value || 0).toFixed(digits);
const pct = (value) => `${fmt(value * 100, 2)}%`;
const healthClass = (value) => (value || "UNKNOWN").toLowerCase();
const safe = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" })[character]);

function related(service) {
  const upstream = new Set(), downstream = new Set(), queue = [service];
  for (const edge of state.serviceGraph) if (edge.destination === service) upstream.add(edge.source);
  while (queue.length) {
    const node = queue.shift();
    for (const edge of state.serviceGraph.filter((item) => item.source === node)) if (!downstream.has(edge.destination)) { downstream.add(edge.destination); queue.push(edge.destination); }
  }
  return new Set([service, ...upstream, ...downstream]);
}

function renderTopology() {
  const svg = $("#topology"), active = related(selected), blast = $("#blast-mode").checked;
  const marker = `<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M0 0 10 5 0 10z" fill="#56657a"/></marker></defs>`;
  const edges = state.serviceGraph.map((edge) => { const a=positions[edge.source], b=positions[edge.destination]; if(!a||!b)return ""; const on=active.has(edge.source)&&active.has(edge.destination); return `<line class="edge ${edge.errorCount ? "error":""} ${on ? "related":""}" x1="${a[0]+70}" y1="${a[1]}" x2="${b[0]-70}" y2="${b[1]}" marker-end="url(#arrow)"><title>${safe(edge.protocol)} · ${edge.requestCount} requests · ${fmt(edge.averageLatencyMs)} ms</title></line>`; }).join("");
  const nodes = state.services.map((service,index) => { const p=positions[service.name]||[120+index*90,380], on=active.has(service.name); return `<g class="node ${healthClass(service.health)} ${service.name===selected?"selected":""} ${blast&&!on?"dim":on?"related":""}" data-service="${safe(service.name)}" transform="translate(${p[0]-70} ${p[1]-25})"><rect width="140" height="50"/><circle cx="14" cy="15" r="5"/><text x="26" y="19">${safe(service.name)}</text><text class="sub" x="14" y="37">${service.metrics.requestCount} req · ${fmt(service.metrics.p95LatencyMs)} ms p95</text></g>`; }).join("");
  svg.innerHTML = marker+edges+nodes;
  svg.querySelectorAll(".node").forEach((node) => node.addEventListener("click", () => { selected=node.dataset.service; render(); }));
}

function renderDetail() {
  const service = state.services.find((item) => item.name === selected);
  if (!service) return;
  $("#detail-name").textContent=service.name;
  $("#detail-health").className=`status ${healthClass(service.health)}`;
  $("#detail-health").textContent=service.health;
  const direct=state.serviceGraph.filter((edge)=>edge.source===selected).map((edge)=>edge.destination);
  const reverse=state.serviceGraph.filter((edge)=>edge.destination===selected).map((edge)=>edge.source);
  $("#service-detail").className="";
  $("#service-detail").innerHTML=`<div class="metrics-grid"><div class="metric"><span>Request rate</span><strong>${fmt(service.metrics.requestRate,2)}/s</strong></div><div class="metric"><span>Error rate</span><strong>${pct(service.metrics.errorRate)}</strong></div><div class="metric"><span>P50 latency</span><strong>${fmt(service.metrics.p50LatencyMs)} ms</strong></div><div class="metric"><span>P95 latency</span><strong>${fmt(service.metrics.p95LatencyMs)} ms</strong></div><div class="metric"><span>Availability</span><strong>${pct(service.metrics.availability)}</strong></div><div class="metric"><span>Error budget</span><strong>${pct(service.metrics.errorBudgetRemaining)}</strong></div></div><div class="relations"><p><b>Runtime</b> ${safe(service.runtime)} · ${safe(service.version)}</p><p><b>Depends on</b> ${direct.map(safe).join(", ")||"none observed"}</p><p><b>Called by</b> ${reverse.map(safe).join(", ")||"none observed"}</p></div>`;
  $("#fault-service").value=service.name;
}

function renderServices() {
  $("#services").innerHTML=state.services.map((service)=>`<tr data-service="${safe(service.name)}"><td>${safe(service.name)}</td><td><span class="status ${healthClass(service.health)}">${service.health}</span></td><td>${service.metrics.requestCount}</td><td>${fmt(service.metrics.requestRate,2)}/s</td><td>${pct(service.metrics.errorRate)}</td><td>${fmt(service.metrics.p50LatencyMs)} ms</td><td>${fmt(service.metrics.p95LatencyMs)} ms</td><td>${fmt(service.metrics.p99LatencyMs)} ms</td><td>${fmt(service.slo,2)}%</td><td><div class="budget"><i style="width:${service.metrics.errorBudgetRemaining*100}%"></i></div></td></tr>`).join("");
  $("#services").querySelectorAll("tr").forEach((row)=>row.addEventListener("click",()=>{selected=row.dataset.service;render();}));
}

function renderFeeds() {
  const active=state.incidents.filter((incident)=>incident.status!=="RESOLVED");
  $("#incident-count").textContent=active.length; $("#incident-badge").textContent=active.length;
  $("#incidents").className=`feed ${state.incidents.length?"":"empty"}`;
  $("#incidents").innerHTML=state.incidents.length?state.incidents.map((incident)=>`<div class="feed-item"><strong><span class="status critical">${incident.severity}</span> ${safe(incident.title)}</strong><time>${new Date(incident.createdAt).toLocaleTimeString()}</time><p>${safe(incident.triggerCondition)} · affected: ${incident.affectedServices.map(safe).join(", ")}</p>${incident.status!=="RESOLVED"?`<div class="feed-actions">${incident.status==="OPEN"?`<button data-ack="${incident.id}">Acknowledge</button>`:""}<button data-resolve="${incident.id}">Resolve</button></div>`:""}</div>`).join(""):"No incidents detected.";
  $("#audit").className=`feed ${state.auditLog.length?"":"empty"}`;
  $("#audit").innerHTML=state.auditLog.length?state.auditLog.map((event)=>`<div class="feed-item"><strong class="audit-action">${safe(event.action)}</strong><time>${new Date(event.timestamp).toLocaleTimeString()}</time><p>${safe(event.actor)} · ${safe(event.resource)}/${safe(event.resourceId)}</p></div>`).join(""):"No operator actions recorded.";
  document.querySelectorAll("[data-ack]").forEach((button)=>button.addEventListener("click",()=>mutate(`mutation($id:ID!){ acknowledgeIncident(id:$id){ id } }`,{id:button.dataset.ack},"Incident acknowledged")));
  document.querySelectorAll("[data-resolve]").forEach((button)=>button.addEventListener("click",()=>mutate(`mutation($id:ID!){ resolveIncident(id:$id){ id } }`,{id:button.dataset.resolve},"Incident resolved")));
}

function renderSummary() {
  const metrics=state.services.map((service)=>service.metrics), requests=metrics.reduce((sum,item)=>sum+item.requestCount,0), errors=requests?metrics.reduce((sum,item)=>sum+item.errorRate*item.requestCount,0)/requests:0;
  $("#system-status").textContent=state.systemHealth.status; $("#system-status").className=`status ${healthClass(state.systemHealth.status)}`;
  $("#service-summary").textContent=`${state.systemHealth.healthy||0} healthy · ${state.systemHealth.critical||0} critical`;
  $("#request-count").textContent=requests.toLocaleString(); $("#error-rate").textContent=pct(errors); $("#p95").textContent=`${fmt(Math.max(0,...metrics.map((item)=>item.p95LatencyMs)))} ms`;
}

function render(){renderSummary();renderTopology();renderDetail();renderServices();renderFeeds();}
async function refresh(){try{state=await graphql(query);render();$("#sync-state").textContent="LIVE";}catch(error){$("#sync-state").textContent="DISCONNECTED";toast(error.message,true);}}
async function mutate(document,variables,message){try{await graphql(document,variables);toast(message);await refresh();}catch(error){toast(error.message,true);}}
function toast(message,error=false){const node=$("#toast");node.textContent=message;node.className=`show ${error?"error":""}`;clearTimeout(toast.timer);toast.timer=setTimeout(()=>node.className="",2600);}

$("#fault-form").addEventListener("submit",(event)=>{event.preventDefault();mutate(`mutation($service:String!,$status:Int!,$latency:Int!,$duration:Int!){ injectFailure(service:$service,status:$status,latencyMs:$latency,durationSeconds:$duration){ id } }`,{service:$("#fault-service").value,status:Number($("#fault-status").value),latency:Number($("#fault-latency").value),duration:Number($("#fault-duration").value)},"Fault injected");});
$("#restore").addEventListener("click",()=>mutate(`mutation($service:String!){ restoreService(service:$service){ id } }`,{service:$("#fault-service").value},"Service restored"));
$("#generate").addEventListener("click",()=>mutate(`mutation{ generateTraffic(count:5){ id } }`,{},"Traffic generated"));
$("#refresh").addEventListener("click",refresh);$("#blast-mode").addEventListener("change",renderTopology);
$("#fault-service").innerHTML=["gateway","identity-api","inventory-api","order-orchestrator","payment-worker","notification-router","analytics-ingestor"].map((name)=>`<option>${name}</option>`).join("");
setInterval(()=>$("#clock").textContent=new Date().toLocaleTimeString(),1000);setInterval(refresh,3000);refresh();

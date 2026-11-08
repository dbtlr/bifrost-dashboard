// Illustrative data for choosing a layout. No connection to a proxy is made.
const apps = [
  {name:'Code',host:'git',group:'Build & run',color:'#fb923c',icon:'git'},
  {name:'Metrics',host:'metrics',group:'Build & run',color:'#ffad42',icon:'chart'},
  {name:'Home',host:'home',group:'Everyday',color:'#48c1f5',icon:'home'},
  {name:'Photos',host:'photos',group:'Media & files',color:'#b8a4ff',icon:'photo'},
  {name:'Video',host:'watch',group:'Media & files',color:'#aa98ff',icon:'play'},
  {name:'Bookmarks',host:'links',group:'Everyday',color:'#aa9bf5',icon:'link'},
  {name:'Files',host:'cloud',group:'Media & files',color:'#54b9ff',icon:'cloud'},
  {name:'Documents',host:'docs',group:'Everyday',color:'#77cd8b',icon:'leaf'},
  {name:'Containers',host:'containers',group:'Build & run',color:'#68b9f3',icon:'containers'},
  {name:'Sync',host:'sync',group:'Media & files',color:'#6cc7ea',icon:'sync'},
  {name:'Status',host:'status',group:'Build & run',color:'#8ce6b4',icon:'pulse'},
  {name:'Secrets',host:'vault',group:'Everyday',color:'#88adff',icon:'shield'},
];
const marks = {
  git:'<rect x="8" y="10" width="28" height="24" rx="3"/><path d="m18 17-5 5 5 5m8-10 5 5-5 5"/>',
  chart:'<path d="M8 8v28h28M15 29V19m8 10V12m8 17v-7"/>',
  home:'<path d="m7 21 15-13 15 13M11 19v17h22V19M19 36V25h6v11"/>',
  photo:'<rect x="7" y="9" width="30" height="26" rx="3"/><circle cx="15" cy="17" r="3"/><path d="m9 32 10-10 6 6 5-5 5 9"/>',
  play:'<rect x="7" y="10" width="30" height="24" rx="4"/><path d="m19 16 10 6-10 6Z"/>',
  link:'<path d="M13 8h18v29l-9-6-9 6ZM18 15h8m-8 6h8"/>',
  cloud:'<path d="M7 13h12l4 5h14v17H7ZM7 18h16"/>',
  leaf:'<rect x="11" y="6" width="22" height="32" rx="2"/><path d="M17 15h10m-10 7h10m-10 7h7"/>',
  containers:'<rect x="7" y="7" width="12" height="12"/><rect x="25" y="7" width="12" height="12"/><rect x="7" y="25" width="12" height="12"/><rect x="25" y="25" width="12" height="12"/>',
  sync:'<path d="M8 15h27l-6-6m6 6-6 6M36 29H9l6 6m-6-6 6-6"/>',
  pulse:'<path d="M6 23h9l5-12 6 22 5-10h7"/>',
  shield:'<rect x="10" y="19" width="24" height="19" rx="3"/><path d="M15 19v-7a7 7 0 0 1 14 0v7M22 26v5"/>',
};
const concepts = {
  launchpad:{number:'01',title:'Launchpad',description:'A familiar homepage. Recognize an icon, open an app.',fit:'Recommended for a simple start page',heading:'Your apps.'},
  collections:{number:'02',title:'Collections',description:'Small, useful groups keep related apps together.',fit:'Best for browsing by purpose',heading:'Everything, in its place.'},
  directory:{number:'03',title:'Directory',description:'Favorite apps within reach. Every domain in view.',fit:'Best for a larger collection of apps',heading:'A shortcut to everything.'},
};
const main = document.querySelector('#main');
const domain = app => `${app.host}.example.test`;
function icon(app){return `<span class="app-icon" style="--icon-color:${app.color}"><svg viewBox="0 0 44 44" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${marks[app.icon]}</svg></span>`;}
function appLink(app,showDomain=true){return `<a class="app" href="https://${domain(app)}" target="_blank" rel="noopener noreferrer" aria-label="Open ${app.name} (${domain(app)})">${icon(app)}${showDomain?`<span class="app-copy"><span class="app-name">${app.name}</span><span class="app-domain">${domain(app)}</span></span>`:`<span class="app-name">${app.name}</span>`}<span class="app-arrow" aria-hidden="true">↗</span></a>`;}
function search(){return '<label class="search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg><input type="search" aria-label="Find an app or domain" placeholder="Find an app or domain…" autocomplete="off"><kbd aria-hidden="true">/</kbd></label>';}
function renderApps(query=''){
  const visible=apps.filter(app=>`${app.name} ${domain(app)} ${app.group}`.toLowerCase().includes(query.toLowerCase()));
  const container=document.querySelector('#app-content');
  if(!visible.length){container.innerHTML='<p class="empty" role="status">No matching apps. Try another name or domain.</p>';return;}
  const current=currentConcept();
  if(current==='launchpad'){
    container.innerHTML=`<div class="section-line"><h2>All apps <span>· ${visible.length}</span></h2><span>A → Z</span></div><div class="launch-grid">${visible.map(app=>`<a class="app" href="https://${domain(app)}" target="_blank" rel="noopener noreferrer" aria-label="Open ${app.name} (${domain(app)})">${icon(app)}<span class="app-name">${app.name}</span><span class="app-domain">${domain(app)}</span><span class="app-arrow" aria-hidden="true">↗</span></a>`).join('')}</div>`;
  }else if(current==='collections'){
    container.innerHTML=`<div class="collections-grid">${['Everyday','Media & files','Build & run'].map(group=>{
      const groupApps=visible.filter(app=>app.group===group);
      return groupApps.length?`<section class="collection"><div class="collection-heading"><h2>${group}</h2><span>${String(groupApps.length).padStart(2,'0')}</span></div>${groupApps.map(app=>appLink(app)).join('')}</section>`:'';
    }).join('')}</div>`;
  }else{
    const favorites=['Home','Photos','Video','Secrets'].map(name=>apps.find(app=>app.name===name));
    container.innerHTML=`<div class="directory-layout"><aside class="favorites"><h2>Favorites</h2><div class="favorite-apps">${favorites.map(app=>appLink(app,false)).join('')}</div></aside><div><table class="directory-table"><thead><tr><th scope="col">App <span>· ${visible.length}</span></th><th scope="col">Domain</th><th scope="col">Collection</th></tr></thead><tbody>${visible.map(app=>`<tr><td>${appLink(app,false)}</td><td><a class="domain-link app-domain" href="https://${domain(app)}" target="_blank" rel="noopener noreferrer">${domain(app)}</a></td><td>${app.group}<span class="row-arrow" aria-hidden="true">↗</span></td></tr>`).join('')}</tbody></table></div></div>`;
  }
}
function currentConcept(){return Object.hasOwn(concepts,location.hash.slice(1))?location.hash.slice(1):'launchpad';}
function render(){
  const current=currentConcept();
  const concept=concepts[current];
  document.title=`Bifrost · ${concept.title} concept`;
  document.querySelectorAll('[data-concept]').forEach(link=>{if(link.dataset.concept===current)link.setAttribute('aria-current','page');else link.removeAttribute('aria-current');});
  main.className=current;
  main.innerHTML=`<div class="heading-row"><h1>${concept.heading}</h1>${search()}</div><div id="app-content"></div>`;
  document.querySelector('#note-number').textContent=concept.number;
  document.querySelector('#note-title').textContent=concept.title;
  document.querySelector('#note-description').textContent=concept.description;
  document.querySelector('#note-fit').textContent=concept.fit;
  document.querySelector('input').addEventListener('input',event=>renderApps(event.target.value));
  renderApps();
}
window.addEventListener('hashchange',render);
window.addEventListener('keydown',event=>{
  if(event.key==='/'&&!['INPUT','TEXTAREA'].includes(document.activeElement.tagName)){event.preventDefault();document.querySelector('input').focus();}
  if(event.key==='Escape'&&document.activeElement.matches('input')){document.activeElement.value='';renderApps();document.activeElement.blur();}
});
render();

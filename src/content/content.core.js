(() => {
  'use strict';
  const KEY='__BTV_CONTENT_RUNTIME__'; if(window[KEY]?.initialized)return;
  const STORE='btvFeatureEnabled', TAG='btv-sentence';
  const HARD='script,style,noscript,pre,textarea,input,select,button,canvas,[contenteditable]:not([contenteditable="false"]),[hidden],[aria-hidden="true"],[role="button"],[role="textbox"],#bilingual-tooltip';
  const PROTECTED='[translate="no"],.notranslate,svg,math';
  const BLOCKS=new Set(['P','LI','DT','DD','TD','TH','H1','H2','H3','H4','H5','H6','BLOCKQUOTE','FIGCAPTION','SECTION','ARTICLE','MAIN','DIV','BODY']);
  const segmenter=typeof Intl.Segmenter==='function'?new Intl.Segmenter(undefined,{granularity:'sentence'}):null;
  const fragments=new WeakMap(),records=new Set(),dirty=new Set();
  let tainted=new WeakSet();
  let nextId=0,epoch=1,enabled=false,translated=false,unknown=false,preparing=false,dirtyQueued=false,observer,tip;
  let uncertaintyTimer=null;
  const uncertaintyCandidates=new Map();
  let baselineLang=document.documentElement?.lang||'',pageUrl=`${location.origin}${location.pathname}${location.search}`;
  const normalize=s=>(s||'').replace(/\s+/g,' ').trim();
  const message=(key,fallback)=>chrome.i18n?.getMessage?.(key)||fallback;

  function marker(){
    const html=document.documentElement;
    return /\btranslated-(ltr|rtl)\b/.test(`${html?.className||''} ${document.body?.className||''}`)
      ||!!(baselineLang&&html?.lang&&html.lang!==baselineLang)||/(?:^|\.)translate\.goog$/.test(location.hostname);
  }
  function live(r){return r.valid&&r.epoch===epoch&&r.parts.length>0
    &&r.parts.every(p=>p.element.isConnected)
    &&r.contexts.every(p=>p.element.isConnected&&normalize(p.element.textContent)===normalize(p.original));}
  function changed(r){return live(r)&&r.parts.some(p=>normalize(p.element.textContent)!==normalize(p.original));}
  function invalidate(r){if(!r?.valid)return;r.valid=false;records.delete(r);r.parts.forEach(p=>fragments.delete(p.element));}
  function prune(){for(const r of [...records])if(!live(r))invalidate(r);}
  function ranges(text){
    const list=segmenter?Array.from(segmenter.segment(text),p=>({start:p.index,end:p.index+p.segment.length}))
      :Array.from(text.matchAll(/[^.!?。！？]+(?:[.!?。！？]+["'”’）)\]]*\s*|$)/g),p=>({start:p.index,end:p.index+p[0].length}));
    if(!list.length&&text.trim())list.push({start:0,end:text.length});
    const out=[]; for(const item of list){const prev=out.at(-1);
      if(prev&&/\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|vs|e\.g|i\.e)\.\s*$/i.test(text.slice(prev.start,prev.end)))prev.end=item.end;
      else out.push({...item});}
    return out.filter(r=>text.slice(r.start,r.end).trim());
  }
  function blockOf(node){
    let el=node?.nodeType===Node.ELEMENT_NODE?node:node?.parentElement;
    while(el&&el!==document.body){const d=getComputedStyle(el).display;
      if(BLOCKS.has(el.tagName)||/^(block|list-item|table-cell|flex|grid)$/.test(d))return el;el=el.parentElement;}
    return document.body;
  }
  function collect(root){
    const runs=[];let run;
    const walker=document.createTreeWalker(root,NodeFilter.SHOW_ELEMENT|NodeFilter.SHOW_TEXT,{acceptNode(node){
      if(node.nodeType===Node.ELEMENT_NODE){
        if(node.matches(HARD)||getComputedStyle(node).display==='none'||getComputedStyle(node).visibility==='hidden'){run=null;return NodeFilter.FILTER_REJECT;}
        if(node.tagName===TAG.toUpperCase())return NodeFilter.FILTER_REJECT;
        if(node.tagName==='BR')run=null;
        return NodeFilter.FILTER_SKIP;
      } return NodeFilter.FILTER_ACCEPT;
    }});
    let node;while((node=walker.nextNode())){
      if(node.nodeType===Node.ELEMENT_NODE){
        const boundary=blockOf(node),value=node.textContent||'';
        if(!run||run.boundary!==boundary){run={boundary,text:'',nodes:[]};runs.push(run);}
        const start=run.text.length;run.text+=value;run.nodes.push({node,start,end:run.text.length,writable:false});
        continue;
      }
      const boundary=blockOf(node);if(!run||run.boundary!==boundary){run={boundary,text:'',nodes:[]};runs.push(run);}
      const start=run.text.length;run.text+=node.nodeValue;run.nodes.push({
        node,start,end:run.text.length,writable:!node.parentElement?.closest(PROTECTED)
      });
    } return runs;
  }
  function anchor(run){
    const sentences=ranges(run.text).map(r=>({...r,id:++nextId,epoch,valid:true,original:normalize(run.text.slice(r.start,r.end)),parts:[],contexts:[]}));
    for(const part of run.nodes){if(!part.writable||!part.node.isConnected||!part.node.nodeValue)continue;
      const frag=document.createDocumentFragment();let cursor=part.start;
      for(const r of sentences){const from=Math.max(part.start,r.start),to=Math.min(part.end,r.end);if(to<=from)continue;
        if(from>cursor)frag.append(document.createTextNode(run.text.slice(cursor,from)));
        const el=document.createElement(TAG),original=run.text.slice(from,to);el.textContent=original;el.dataset.id=String(r.id);
        fragments.set(el,r);r.parts.push({element:el,original});frag.append(el);cursor=to;}
      if(cursor<part.end)frag.append(document.createTextNode(run.text.slice(cursor,part.end)));
      if(frag.childNodes.length)part.node.replaceWith(frag);
    }
    for(const part of run.nodes){if(part.writable)continue;for(const r of sentences){
      if(Math.min(part.end,r.end)>Math.max(part.start,r.start))r.contexts.push({element:part.node,original:part.node.textContent||''});
    }}
    for(const r of sentences)if(r.parts.length)records.add(r);
  }
  function capture(root){for(const run of collect(root))if(!tainted.has(run.boundary))anchor(run);}
  function unwrap(root=document.body,invalidateRecords=true){
    if(!root)return;for(const el of [...root.querySelectorAll(TAG)]){const r=fragments.get(el);if(invalidateRecords&&r)invalidate(r);el.replaceWith(...el.childNodes);}
  }
  function observe(){if(!enabled||!document.documentElement)return;observer??=new MutationObserver(onMutations);
    observer.observe(document.documentElement,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['lang','class','hidden','style','aria-hidden']});}
  function paused(fn){observer?.disconnect();try{return fn();}finally{observe();}}
  function prepare({force=false}={}){
    if(!enabled)return{ok:false,error:'disabled'};if(!document.body)return{ok:false,error:'loading'};if(preparing)return{ok:false,error:'busy'};
    translated=marker();prune();if(translated)return{ok:false,error:'alreadyTranslated'};
    if(unknown&&!force)return{ok:false,error:'uncertainSource'};
    preparing=true;const before=records.size;
    try{return paused(()=>{if(force){epoch++;unwrap(document.body);records.clear();tainted=new WeakSet();baselineLang=document.documentElement.lang||'';unknown=false;}capture(document.body);
      return{ok:true,complete:true,sentences:records.size,added:records.size-before};});}
    catch(e){console.error('[Translate Recall] Preprocess failed',e);return{ok:false,error:'prepareFailed'};}finally{preparing=false;}
  }
  function containing(node){let el=node?.nodeType===Node.ELEMENT_NODE?node:node?.parentElement;
    while(el){const r=fragments.get(el);if(r&&live(r))return{record:r,element:el};el=el.parentElement;}return null;}
  function scheduleUncertainty(record,root){
    if(record?.valid)uncertaintyCandidates.set(record,root);
    if(uncertaintyTimer!==null)return;
    uncertaintyTimer=setTimeout(()=>{
      uncertaintyTimer=null;
      if(marker()){
        translated=true;
        uncertaintyCandidates.clear();
        return;
      }
      for(const [candidate,boundary] of uncertaintyCandidates){
        if(changed(candidate)){
          unknown=true;
          tainted.add(boundary);
          invalidate(candidate);
        }
      }
      uncertaintyCandidates.clear();
    },80);
  }
  function schedule(root){if(!root?.isConnected)return;dirty.add(root);if(!dirtyQueued){dirtyQueued=true;queueMicrotask(flush);}}
  function flush(){dirtyQueued=false;if(!enabled||translated||preparing){dirty.clear();return;}
    const roots=[...dirty].filter(r=>r.isConnected&&![...dirty].some(o=>o!==r&&o.contains(r)));dirty.clear();
    paused(()=>{for(const root of roots){if(tainted.has(root))continue;const els=[...root.querySelectorAll(TAG)],set=new Set(els.map(e=>fragments.get(e)).filter(Boolean));
      if([...set].some(changed)){unknown=true;tainted.add(root);for(const r of set)if(changed(r))invalidate(r);continue;}
      for(const r of set)invalidate(r);unwrap(root,false);capture(root);}});
  }
  function onMutations(mutations){
    if(!enabled||preparing)return;const was=translated;translated=marker();
    const currentPageUrl=`${location.origin}${location.pathname}${location.search}`,urlChanged=currentPageUrl!==pageUrl;
    if(urlChanged){
      pageUrl=currentPageUrl;hide();epoch++;for(const record of [...records])invalidate(record);
      tainted=new WeakSet();dirty.clear();
      if(was)unknown=true;
    }
    if(translated)return;
    for(const m of mutations){if(m.target===tip||tip?.contains(m.target))continue;
      if(m.type==='attributes'){
        if(m.target===document.documentElement)continue;
        const hasAnchor=m.target.tagName===TAG.toUpperCase()||m.target.querySelector?.(TAG);
        if(!hasAnchor&&normalize(m.target.textContent))schedule(blockOf(m.target));continue;
      }
      const hit=containing(m.target);if(hit&&changed(hit.record)){scheduleUncertainty(hit.record,blockOf(m.target));continue;}schedule(blockOf(m.target));}
    prune();if(was&&urlChanged&&records.size===0)dirty.clear();
  }
  function ensureTip(){
    if(tip?.isConnected)return tip;tip=document.createElement('div');tip.id='bilingual-tooltip';tip.className='notranslate';tip.translate=false;
    tip.innerHTML=`<div class="btv-tip-text"></div><div class="btv-tip-status" aria-live="polite"></div><div class="btv-tip-actions"><button type="button" data-action="copy">${message('tooltipCopy','Copy')}</button><button type="button" data-action="close" aria-label="${message('tooltipClose','Close')}">×</button></div>`;
    tip.addEventListener('click',async e=>{const action=e.target.closest('button')?.dataset.action;if(action==='close')hide();
      if(action==='copy'){const status=tip.querySelector('.btv-tip-status');try{await navigator.clipboard.writeText(tip.dataset.copyText||'');status.textContent=message('tooltipCopied','Copied.');}
        catch(_){try{const a=document.createElement('textarea');a.value=tip.dataset.copyText||'';document.body.append(a);a.select();const ok=document.execCommand('copy');a.remove();if(!ok)throw Error();status.textContent=message('tooltipCopied','Copied.');}catch(_e){status.textContent=message('tooltipCopyFailed','Copy failed. Select the text and copy it manually.');}}}});
    document.body.append(tip);return tip;
  }
  function hide(){if(tip){tip.style.display='none';delete tip.dataset.originalText;delete tip.dataset.copyText;
    const text=tip.querySelector('.btv-tip-text'),status=tip.querySelector('.btv-tip-status');if(text)text.textContent='';if(status)status.textContent='';}}
  function show(text,x,y,{copyText=text,missing=false}={}){
    const el=ensureTip();if(!el||!text)return;el.dataset.originalText=text;el.dataset.copyText=copyText;
    el.querySelector('.btv-tip-text').textContent=text;el.querySelector('.btv-tip-status').textContent='';el.classList.toggle('has-missing',missing);
    el.style.display='block';el.style.left='8px';el.style.top='8px';const r=el.getBoundingClientRect(),h=Math.min(r.height,innerHeight-16);
    el.style.left=`${Math.max(8,Math.min(x-r.width/2,innerWidth-r.width-8))}px`;
    el.style.top=`${Math.max(8,Math.min(y-h-14<8?y+14:y-h-14,innerHeight-h-8))}px`;
  }
  function textHit(x,y){const r=document.caretRangeFromPoint?.(x,y),p=!r&&document.caretPositionFromPoint?.(x,y),node=r?.startContainer||p?.offsetNode,off=r?.startOffset??p?.offset;
    if(node?.nodeType!==Node.TEXT_NODE)return null;for(const i of[off,off-1]){if(i<0||i>=node.length||!node.data[i].trim())continue;
      const g=document.createRange();g.setStart(node,i);g.setEnd(node,i+1);if([...g.getClientRects()].some(q=>x>=q.left&&x<=q.right&&y>=q.top&&y<=q.bottom))return node;}return null;}
  function onClick(e){if(!enabled||e.button!==0||tip?.contains(e.target)||getSelection()?.toString().trim())return;
    translated=marker();const hit=containing(textHit(e.clientX,e.clientY));if(!hit||!translated)return hide();show(hit.record.original,e.clientX,e.clientY);}
  function onMouseUp(e){
    if(!enabled||e.button!==0||tip?.contains(e.target))return;const sel=getSelection();if(!sel?.rangeCount||!sel.toString().trim())return;
    translated=marker();
    const range=sel.getRangeAt(0),root=range.commonAncestorContainer.nodeType===Node.TEXT_NODE?range.commonAncestorContainer.parentElement:range.commonAncestorContainer;
    const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT),known=new Map();let missing=false,node;
    while((node=walker.nextNode())){if(!range.intersectsNode(node))continue;
      const selectedStart=node===range.startContainer?range.startOffset:0;
      const selectedEnd=node===range.endContainer?range.endOffset:node.length;
      if(selectedEnd<=selectedStart||!node.data.slice(selectedStart,selectedEnd).trim())continue;const hit=containing(node);
      if(hit&&translated)known.set(hit.record.id,hit.record.original);else if(!tip?.contains(node))missing=true;}
    if(known.size||missing){const originals=[...known.values()].join('\n\n'),notice=known.size
      ?message('tooltipPartialMissing','[Some selected text has no captured original.]')
      :message('tooltipAllMissing','[No captured original is available for this selection.]');
      show(missing?`${originals}${originals?'\n\n':''}${notice}`:originals,e.clientX,e.clientY,{copyText:originals,missing});}else hide();
  }
  function restore(){paused(()=>{unknown=true;epoch++;tainted.add(document.body);unwrap(document.body);records.clear();dirty.clear();uncertaintyCandidates.clear();
    if(uncertaintyTimer!==null){clearTimeout(uncertaintyTimer);uncertaintyTimer=null;}});hide();return{ok:true,restored:true};}
  function setEnabled(value){enabled=!!value;if(enabled){prepare();observe();}else{observer?.disconnect();hide();}}
  chrome.runtime.onMessage.addListener((m,_s,respond)=>{
    if(m?.type==='BTV_PING')respond({ok:true,enabled,unknown,version:'1.5.2'});
    else if(m?.type==='BTV_PREPROCESS_NOW')respond(prepare());
    else if(m?.type==='BTV_RECAPTURE_SOURCE')respond(prepare({force:true}));
    else if(m?.type==='BTV_RESTORE_STRUCTURE')respond(restore());
    else if(m?.type==='BTV_GET_STATUS')respond({ok:true,enabled,translated,unknown,sentences:records.size});
    else if(m?.type==='BTV_SET_ENABLED'){setEnabled(m.enabled);respond({ok:true,enabled});}
  });
  document.addEventListener('click',onClick,true);document.addEventListener('mouseup',onMouseUp,true);
  document.addEventListener('keydown',e=>{if(e.key==='Escape')hide();},true);window.addEventListener('resize',hide);
  document.addEventListener('scroll',e=>{if(!tip?.contains(e.target))hide();},true);
  chrome.storage.onChanged.addListener((c,a)=>{if(a==='local'&&c[STORE])setEnabled(c[STORE].newValue===true);});
  chrome.storage.local.get(STORE,r=>{if(!chrome.runtime.lastError)setEnabled(r[STORE]===true);});
  window[KEY]={initialized:true,startedAt:Date.now(),version:'1.5.2'};
})();

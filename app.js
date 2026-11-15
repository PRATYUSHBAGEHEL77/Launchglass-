import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const config = window.LAUNCHGLASS_CONFIG || {};
const configured = /^https:\/\/.+\.supabase\.co$/.test(config.SUPABASE_URL || '') &&
  !!config.SUPABASE_ANON_KEY && !String(config.SUPABASE_ANON_KEY).includes('YOUR_');
const $ = (id) => document.getElementById(id);
const escapeHTML = (value='') => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let supabase = null;
let currentUser = null;
let currentCampaignId = null;
let loadingWorkspace = false;

function notify(message, ms=4200) {
  const el = $('appNotice');
  if (!el) return;
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => el.classList.remove('show'), ms);
}
function authMessage(message, isError=true) {
  const el = $('authMessage');
  if (el) { el.textContent = message; el.style.color = isError ? '#e8b86a' : '#78d8ad'; }
}
function setBusy(button, busy, label) {
  if (!button) return;
  if (busy) { button.dataset.originalText = button.textContent; button.disabled = true; button.textContent = label || 'Working…'; }
  else { button.disabled = false; if (button.dataset.originalText) button.textContent = button.dataset.originalText; }
}
function downloadJSON(filename, payload) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function setAuthenticatedUI(user) {
  currentUser = user || null;
  $('authGate').hidden = !!user;
  $('appShell').hidden = !user;
  $('accountChip').textContent = user?.email || '';
  if (user) {
    $('authMessage').textContent = '';
    loadWorkspace();
    loadPublicCampaigns();
    loadMyProfile();
    loadManufacturerDirectory();
    loadManufacturingPortal();
    checkAdmin();
  }
}

if (!configured) {
  $('configHint').hidden = false;
  $('googleSignIn').disabled = true;
  $('googleSignIn').style.opacity = '.55';
  authMessage('Add your Supabase project URL and publishable/anon key in config.js, then reload.');
} else {
  supabase = createClient(config.SUPABASE_URL, config.SUPABASE_ANON_KEY, {
    auth: { persistSession:true, autoRefreshToken:true, detectSessionInUrl:true }
  });

  $('googleSignIn').addEventListener('click', async () => {
    setBusy($('googleSignIn'), true, 'Redirecting to Google…');
    authMessage('Opening Google sign-in…', false);
    const { error } = await supabase.auth.signInWithOAuth({
      provider:'google',
      options:{ redirectTo: window.location.origin, queryParams:{ prompt:'select_account' } }
    });
    if (error) { authMessage(error.message); setBusy($('googleSignIn'), false); }
  });

  $('signOutButton').addEventListener('click', async () => {
    const { error } = await supabase.auth.signOut();
    if (error) notify(error.message); else { setAuthenticatedUI(null); authMessage('You have signed out.', false); }
  });

  supabase.auth.onAuthStateChange((_event, session) => {
    setAuthenticatedUI(session?.user || null);
  });
  const { data:{ session }, error } = await supabase.auth.getSession();
  if (error) authMessage(error.message);
  setAuthenticatedUI(session?.user || null);
}

async function requireClient() {
  if (!supabase || !currentUser) { notify('Please sign in with Google first.'); return false; }
  return true;
}

async function runGemini(action, title, description) {
  if (!(await requireClient())) throw new Error('Sign in is required.');
  const { data, error } = await supabase.functions.invoke('idea-assistant', {
    body:{ action, title:String(title || '').slice(0,180), description:String(description || '').slice(0,12000) }
  });
  if (error) {
    let detail = error.message || 'Gemini function request failed.';
    try { const ctx = error.context; if (ctx?.json) { const body = await ctx.json(); detail = body.error || body.message || detail; } } catch (_) {}
    throw new Error(detail + ' Check that the idea-assistant Edge Function is deployed and GEMINI_API_KEY is set as a Supabase secret.');
  }
  if (!data?.text) throw new Error(data?.error || 'Gemini returned an empty response.');
  return data.text;
}

async function saveAIDocument(kind,title,context,content) {
  const {error}=await supabase.from('ai_documents').insert({user_id:currentUser.id,kind,title:String(title||'').slice(0,180),context:String(context||'').slice(0,12000),content});
  if(error) throw error;
}

// Idea Analyzer: Gemini response is stored with the user's own row under RLS.
$('analyzeIdea')?.addEventListener('click', async () => {
  const title = $('ideaTitle').value.trim() || 'Untitled product idea';
  const description = $('ideaDescription').value.trim();
  const box = $('ideaResult');
  if (description.length < 20) { box.textContent = 'Please describe the idea in at least 20 characters.'; box.classList.add('show'); return; }
  const button = $('analyzeIdea'); setBusy(button, true, 'Gemini is analyzing…'); box.textContent = 'Preparing your analysis…'; box.classList.add('show');
  try {
    const analysis = await runGemini('idea_analysis', title, description);
    box.textContent = analysis;
    const { error } = await supabase.from('ideas').insert({user_id:currentUser.id,title,description,analysis});
    if (error) throw error;
    notify('Idea analysis saved to your workspace.');
    await loadWorkspace();
  } catch (error) { box.textContent = 'Could not complete the AI analysis.\n\n' + error.message; notify(error.message); }
  finally { setBusy(button, false); }
});
$('clearIdea')?.addEventListener('click', () => { $('ideaTitle').value=''; $('ideaDescription').value=''; $('ideaResult').textContent=''; $('ideaResult').classList.remove('show'); });

// Optional business plan generator using the same authenticated Gemini function.
const toolkit = document.querySelector('#ai-workbench .grid3 .infoCard');
if (toolkit && !document.getElementById('generateBusinessPlan')) {
  const b = document.createElement('button'); b.className='btn primary'; b.id='generateBusinessPlan'; b.type='button'; b.textContent='Generate business plan with Gemini';
  const out = document.createElement('div'); out.id='businessPlanResult'; out.className='resultBox'; out.style.marginTop='12px';
  toolkit.append(b,out);
  b.addEventListener('click', async () => {
    const title=$('ideaTitle').value.trim(), desc=$('ideaDescription').value.trim(), box=$('businessPlanResult');
    if(desc.length<20){notify('Enter your idea in the Idea Analyzer first (at least 20 characters).');return;}
    setBusy(b,true,'Building plan…'); box.textContent='Gemini is preparing a first-draft business plan…'; box.classList.add('show');
    try { box.textContent=await runGemini('business_plan',title,desc); await saveAIDocument('business_plan',title,desc,box.textContent); notify('Business plan saved to your workspace.'); await loadWorkspace(); }
    catch(e){box.textContent=e.message;}
    finally{setBusy(b,false);}
  });
}

function campaignForm() {
  const name=$('campaignName').value.trim(), story=$('campaignStory').value.trim();
  const goal=Number($('campaignGoal').value), days=Number($('campaignDays').value);
  const reward=$('campaignReward').value.trim(), category=$('campaignCategory').value;
  if (!name || story.length<20 || !Number.isFinite(goal) || goal<=0 || !Number.isInteger(days) || days<1 || days>90 || !category) throw new Error('Complete the name, a story of at least 20 characters, a positive funding goal, 1–90 days and a category.');
  return {name,story,goal,duration_days:days,reward,category,image_url:window.launchglassCampaignImageUrl||null};
}
$('previewCampaign')?.addEventListener('click', () => {
  const box=$('campaignResult');
  try { const c=campaignForm(); box.textContent=`CAMPAIGN PREVIEW — DRAFT ONLY\n\n${c.name}\nCategory: ${c.category}\nGoal: ₹${c.goal.toLocaleString('en-IN')}\nDuration: ${c.duration_days} days\nReward: ${c.reward || 'Not specified'}\n\n${c.story}\n\nA preview does not publish the campaign or collect contributions.`; }
  catch(e){box.textContent=e.message;}
  box.classList.add('show');
});
$('generateCampaignCopy')?.addEventListener('click', async () => {
  const box=$('campaignResult');
  try {
    const name=$('campaignName').value.trim() || 'New product';
    const context=$('campaignStory').value.trim();
    if(context.length<20) throw new Error('Write a short product description first (at least 20 characters).');
    setBusy($('generateCampaignCopy'),true,'Writing with Gemini…');
    const text=await runGemini('campaign_copy',name,context);
    await saveAIDocument('campaign_copy',name,context,text);
    $('campaignStory').value=text;
    box.textContent='Gemini drafted a campaign story. Review and edit it before saving.'; box.classList.add('show');
  } catch(e){box.textContent=e.message;box.classList.add('show');}
  finally{setBusy($('generateCampaignCopy'),false);}
});


// Phase 1 support: persistent profile and campaign cover uploads.
window.launchglassCampaignImageUrl = null;
$('uploadCampaignImage')?.addEventListener('click',()=> $('campaignImage')?.click());
$('campaignImage')?.addEventListener('change',async e=>{
 const file=e.target.files?.[0]; if(!file)return;
 if(!(await requireClient())){e.target.value='';return;}
 if(!/^image\/(jpeg|png|webp)$/.test(file.type)){notify('Choose a JPG, PNG or WebP image.');e.target.value='';return;}
 if(file.size>5*1024*1024){notify('Image must be 5 MB or smaller.');e.target.value='';return;}
 const btn=$('uploadCampaignImage');setBusy(btn,true,'Uploading…');
 try{const ext=file.type==='image/png'?'png':file.type==='image/webp'?'webp':'jpg';const path=`${currentUser.id}/${crypto.randomUUID()}.${ext}`;
  const {error}=await supabase.storage.from('campaign-media').upload(path,file,{cacheControl:'3600',upsert:false,contentType:file.type});if(error)throw error;
  const {data}=supabase.storage.from('campaign-media').getPublicUrl(path);window.launchglassCampaignImageUrl=data.publicUrl;
  $('campaignImagePreview').src=data.publicUrl;$('campaignImagePreview').hidden=false;notify('Image uploaded. Save your draft to attach it.');
 }catch(err){notify('Image upload failed: '+err.message);}finally{setBusy(btn,false);}
});
async function loadMyProfile(){if(!supabase||!currentUser)return;const {data,error}=await supabase.from('profiles').select('email,full_name,bio,website,account_type').eq('id',currentUser.id).maybeSingle();if(error){notify('Profile could not load: '+error.message);return;}if(!data)return;
 $('profileEmail').textContent=data.email||currentUser.email||'';$('profileFullName').value=data.full_name||currentUser.user_metadata?.full_name||currentUser.user_metadata?.name||'';$('profileBio').value=data.bio||'';$('profileWebsite').value=data.website||'';$('profileType').value=data.account_type||'creator';}
$('saveProfile')?.addEventListener('click',async()=>{if(!(await requireClient()))return;const full_name=$('profileFullName').value.trim().slice(0,120),bio=$('profileBio').value.trim().slice(0,500),raw=$('profileWebsite').value.trim(),account_type=$('profileType').value;if(!full_name){notify('Enter your display name.');return;}let website=null;if(raw){try{const u=new URL(raw);if(!['http:','https:'].includes(u.protocol))throw 0;website=u.href;}catch{notify('Enter a valid https:// website URL.');return;}}const b=$('saveProfile');setBusy(b,true,'Saving…');try{const {error}=await supabase.from('profiles').update({full_name,bio,website,account_type}).eq('id',currentUser.id);if(error)throw error;$('accountChip').textContent=full_name;notify('Profile saved.');}catch(e){notify('Profile save failed: '+e.message);}finally{setBusy(b,false);}});

async function saveCampaign(showToast=true) {
  if (!(await requireClient())) throw new Error('Sign in is required.');
  const c=campaignForm();
  let result;
  if (currentCampaignId) {
    result=await supabase.from('campaigns').update(c).eq('id',currentCampaignId).select('id').single();
  } else {
    result=await supabase.from('campaigns').insert({...c,user_id:currentUser.id}).select('id').single();
  }
  if (result.error) throw result.error;
  currentCampaignId=result.data.id;
  if(showToast) notify('Campaign draft saved securely.');
  await loadWorkspace();
  return currentCampaignId;
}
$('saveCampaign')?.addEventListener('click', async () => {
  const b=$('saveCampaign'); setBusy(b,true,'Saving…');
  try { await saveCampaign(); $('campaignResult').textContent='Draft saved to My Workspace. It is not public yet.'; $('campaignResult').classList.add('show'); }
  catch(e){notify(e.message);$('campaignResult').textContent=e.message;$('campaignResult').classList.add('show');}
  finally{setBusy(b,false);}
});
$('submitCampaign')?.addEventListener('click', async () => {
  const b=$('submitCampaign'); setBusy(b,true,'Submitting…');
  try {
    const id=await saveCampaign(false);
    const {error}=await supabase.rpc('submit_campaign',{p_campaign_id:id});
    if(error) throw error;
    notify('Campaign submitted for owner review. It will appear publicly only after approval.');
    $('campaignResult').textContent='Submitted for review. You can follow its status in My Workspace.'; $('campaignResult').classList.add('show');
    await loadWorkspace();
  } catch(e){notify(e.message);$('campaignResult').textContent=e.message;$('campaignResult').classList.add('show');}
  finally{setBusy(b,false);}
});

// Contact / creator / manufacturer enquiry form.
$('demoForm')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!(await requireClient())) return;
  const form=event.currentTarget;
  const payload={user_id:currentUser.id,name:$('leadName').value.trim(),email:$('leadEmail').value.trim(),request_type:$('leadType').value,message:$('leadMessage').value.trim()};
  const button=form.querySelector('button[type="submit"]'); setBusy(button,true,'Sending…');
  try {
    const {error}=await supabase.from('leads').insert(payload);
    if(error) throw error;
    $('message').textContent='Your enquiry has been sent and saved.';
    form.reset(); notify('Enquiry received.');
    if (document.getElementById('owner-console') && !$('owner-console').hidden) await loadAdmin();
  } catch(e){$('message').textContent='Could not send: '+e.message;}
  finally{setBusy(button,false);}
});

async function loadWorkspace() {
  if (!supabase || !currentUser || loadingWorkspace) return;
  loadingWorkspace=true;
  try {
    const [ideasRes,campaignsRes,interestsRes,docsRes]=await Promise.all([
      supabase.from('ideas').select('id,title,description,analysis,created_at').order('created_at',{ascending:false}).limit(50),
      supabase.from('campaigns').select('id,name,goal,category,status,created_at').order('created_at',{ascending:false}).limit(50),
      supabase.from('campaign_interests').select('id,created_at,campaigns(id,name,category,status)').order('created_at',{ascending:false}).limit(50),
      supabase.from('ai_documents').select('id,kind,title,content,created_at').order('created_at',{ascending:false}).limit(50)
    ]);
    if(ideasRes.error) throw ideasRes.error;
    if(campaignsRes.error) throw campaignsRes.error;
    if(interestsRes.error) throw interestsRes.error;
    if(docsRes.error) throw docsRes.error;
    $('myIdeas').innerHTML=ideasRes.data.length ? ideasRes.data.map(x=>`<div class="workspaceItem"><div><strong>${escapeHTML(x.title)}</strong><small>${new Date(x.created_at).toLocaleString()} · ${escapeHTML(x.description.slice(0,100))}</small></div><span class="statusPill">Saved</span></div>`).join('') : '<p class="mono">No saved ideas yet. Run the Idea Analyzer to start.</p>';
    $('myCampaigns').innerHTML=campaignsRes.data.length ? campaignsRes.data.map(x=>`<div class="workspaceItem"><div><strong>${escapeHTML(x.name)}</strong><small>₹${Number(x.goal).toLocaleString('en-IN')} · ${escapeHTML(x.category)} · ${new Date(x.created_at).toLocaleDateString()}</small></div><span class="statusPill">${escapeHTML(x.status)}</span></div>`).join('') : '<p class="mono">No campaigns yet. Create a campaign draft above.</p>';
    $('myInterests').innerHTML=interestsRes.data.length ? interestsRes.data.map(x=>`<div class="workspaceItem"><div><strong>${escapeHTML(x.campaigns?.name || 'Campaign')}</strong><small>${escapeHTML(x.campaigns?.category || '')}</small></div><span class="statusPill">Following</span></div>`).join('') : '<p class="mono">You are not following any approved campaigns yet.</p>';
    $('myAIDocuments').innerHTML=docsRes.data.length?docsRes.data.map(x=>`<div class="workspaceItem"><div><strong>${escapeHTML(x.title||x.kind)}</strong><small>${escapeHTML(x.kind.replaceAll('_',' '))} · ${new Date(x.created_at).toLocaleDateString()} · ${escapeHTML(x.content.slice(0,90))}</small></div><button class="btn" data-open-ai-doc="${x.id}" type="button">View</button></div>`).join(''):'<p class="mono">Generated plans and checklists will be saved here.</p>';
  } catch(e) { notify('Workspace could not load: '+e.message); }
  finally { loadingWorkspace=false; }
}

let publicCampaignCache=[];
let followedCampaignIds=new Set();
function renderPublicCampaigns(){
 const box=$('liveCampaigns');if(!box)return;
 const query=($('campaignSearch')?.value||'').trim().toLowerCase();const category=$('campaignCategoryFilter')?.value||'all';const sort=$('campaignSort')?.value||'newest';
 let rows=publicCampaignCache.filter(c=>(category==='all'||c.category===category)&&(!query||[c.name,c.story,c.category].some(v=>String(v||'').toLowerCase().includes(query))));
 rows.sort((x,y)=>sort==='goal-low'?Number(x.goal)-Number(y.goal):sort==='goal-high'?Number(y.goal)-Number(x.goal):sort==='name'?x.name.localeCompare(y.name):new Date(y.created_at)-new Date(x.created_at));
 $('campaignResultCount').textContent=`${rows.length} approved campaign${rows.length===1?'':'s'} found`;
 if(!rows.length){box.innerHTML='<p class="mono">No approved campaigns match your search yet. Try another keyword or category.</p>';return;}
 box.innerHTML=rows.map(c=>`<article class="liveCampaignCard">${c.image_url?`<img class="liveCampaignCover" src="${escapeHTML(c.image_url)}" alt="Cover image for ${escapeHTML(c.name)}" loading="lazy">`:`<div class="liveCampaignCoverFallback" aria-hidden="true">✧</div>`}<div class="liveCampaignContent"><span class="chip">${escapeHTML(c.category)}</span><h3>${escapeHTML(c.name)}</h3><p>${escapeHTML(c.story.slice(0,170))}${c.story.length>170?'…':''}</p><div class="mono">GOAL · ₹${Number(c.goal).toLocaleString('en-IN')} · ${c.duration_days} DAYS</div><div class="campaignCardActions"><button class="btn" data-view-campaign="${c.id}" type="button">View details</button><button class="btn primary" data-follow-campaign="${c.id}" type="button">${followedCampaignIds.has(c.id)?'Following ✓':'Follow campaign'}</button></div></div></article>`).join('');
 box.querySelectorAll('[data-follow-campaign]').forEach(b=>b.addEventListener('click',()=>toggleInterest(b.dataset.followCampaign,b)));
 box.querySelectorAll('[data-view-campaign]').forEach(b=>b.addEventListener('click',()=>openCampaignDetail(b.dataset.viewCampaign)));
}
function openCampaignDetail(id){const c=publicCampaignCache.find(x=>x.id===id);if(!c)return;const dlg=$('campaignDetailDialog');$('campaignDetailTitle').textContent=c.name;$('campaignDetailCategory').textContent=c.category;$('campaignDetailMeta').textContent=`Funding goal ₹${Number(c.goal).toLocaleString('en-IN')} · ${c.duration_days} days · Published ${new Date(c.created_at).toLocaleDateString('en-IN')}`;$('campaignDetailStory').textContent=c.story;$('campaignDetailReward').textContent=c.reward?`Potential reward: ${c.reward}`:'Reward details have not been provided.';const img=$('campaignDetailImage');img.src=c.image_url||'';img.hidden=!c.image_url;const follow=$('campaignDetailFollow');follow.dataset.followCampaign=c.id;follow.textContent=followedCampaignIds.has(c.id)?'Following ✓':'Follow campaign';follow.onclick=()=>toggleInterest(c.id,follow);if(typeof dlg.showModal==='function')dlg.showModal();else dlg.setAttribute('open','');}
$('closeCampaignDetail')?.addEventListener('click',()=> $('campaignDetailDialog')?.close());
$('campaignDetailDialog')?.addEventListener('click',e=>{if(e.target===$('campaignDetailDialog'))$('campaignDetailDialog').close();});
['campaignSearch','campaignCategoryFilter','campaignSort'].forEach(id=>$(id)?.addEventListener(id==='campaignSearch'?'input':'change',renderPublicCampaigns));
async function loadPublicCampaigns(){if(!supabase)return;const box=$('liveCampaigns');try{
 const {data,error}=await supabase.from('campaigns').select('id,name,story,goal,duration_days,category,reward,image_url,created_at').eq('status','approved').order('created_at',{ascending:false}).limit(100);if(error)throw error;publicCampaignCache=data||[];
 const select=$('campaignCategoryFilter');if(select){const previous=select.value;const categories=[...new Set(publicCampaignCache.map(c=>c.category).filter(Boolean))].sort();select.innerHTML='<option value="all">All categories</option>'+categories.map(c=>`<option value="${escapeHTML(c)}">${escapeHTML(c)}</option>`).join('');if(categories.includes(previous))select.value=previous;}
 if(currentUser){const {data:followed,error:followError}=await supabase.from('campaign_interests').select('campaign_id').eq('user_id',currentUser.id);if(followError)throw followError;followedCampaignIds=new Set((followed||[]).map(x=>x.campaign_id));}else followedCampaignIds=new Set();
 renderPublicCampaigns();
 }catch(e){box.innerHTML=`<p class="mono">Campaigns could not be loaded: ${escapeHTML(e.message)}</p>`;$('campaignResultCount').textContent='Campaign discovery unavailable';}}
async function toggleInterest(campaignId,button) {
  if(!(await requireClient())) return;
  setBusy(button,true,'Saving…');
  try {
    const {data,error}=await supabase.from('campaign_interests').select('id').eq('campaign_id',campaignId).eq('user_id',currentUser.id).maybeSingle();
    if(error) throw error;
    if(data){const del=await supabase.from('campaign_interests').delete().eq('id',data.id);if(del.error)throw del.error;notify('Removed from your followed campaigns.');}
    else {const ins=await supabase.from('campaign_interests').insert({campaign_id:campaignId,user_id:currentUser.id});if(ins.error)throw ins.error;notify('Campaign added to your workspace.');}
    await loadWorkspace(); await loadPublicCampaigns();
  } catch(e){notify(e.message);}
  finally{setBusy(button,false);}
}

async function checkAdmin() {
  if(!supabase || !currentUser) return;
  const {data,error}=await supabase.from('admin_users').select('user_id').eq('user_id',currentUser.id).maybeSingle();
  if(error){console.warn('Admin check:',error.message);return;}
  if(data){$('owner-console').hidden=false;const adminTab=document.querySelector('.roleTab[data-role="admin"]');if(adminTab)adminTab.hidden=false;await loadAdmin();}
  else {$('owner-console').hidden=true;const adminTab=document.querySelector('.roleTab[data-role="admin"]');if(adminTab)adminTab.hidden=true;}
}
function tableHTML(headers, rows) {
  if(!rows.length) return '<p class="mono" style="padding:12px">No records yet.</p>';
  return `<table class="ownerTable"><thead><tr>${headers.map(h=>`<th>${escapeHTML(h)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`;
}
async function loadAdmin() {
  if(!supabase || !currentUser) return;
  try {
    const [users,ideas,campaigns,leads,interests,aiDocs]=await Promise.all([
      supabase.from('profiles').select('id,email,full_name,created_at').order('created_at',{ascending:false}).limit(300),
      supabase.from('ideas').select('id,user_id,title,description,created_at').order('created_at',{ascending:false}).limit(300),
      supabase.from('campaigns').select('id,user_id,name,goal,category,status,created_at').order('created_at',{ascending:false}).limit(300),
      supabase.from('leads').select('id,user_id,name,email,request_type,message,created_at').order('created_at',{ascending:false}).limit(300),
      supabase.from('campaign_interests').select('id,user_id,campaign_id,created_at').order('created_at',{ascending:false}).limit(500),
      supabase.from('ai_documents').select('id,user_id,kind,title,created_at').order('created_at',{ascending:false}).limit(500)
    ]);
    for(const r of [users,ideas,campaigns,leads,interests,aiDocs]) if(r.error) throw r.error;
    $('ownerStats').innerHTML=[['Users',users.data.length],['Ideas',ideas.data.length],['Campaigns',campaigns.data.length],['Enquiries',leads.data.length]].map(x=>`<div class="ownerStat"><b>${x[1]}</b><span>${x[0]}</span></div>`).join('');
    const pending=campaigns.data.filter(c=>c.status==='submitted');
    $('adminCampaigns').innerHTML=pending.length?pending.map(c=>`<div class="workspaceItem"><div><strong>${escapeHTML(c.name)}</strong><small>${escapeHTML(c.category)} · ₹${Number(c.goal).toLocaleString('en-IN')} · User ${escapeHTML(c.user_id)}</small></div><div class="actionRow"><button class="btn primary" data-review="approved" data-id="${c.id}">Approve</button><button class="btn" data-review="rejected" data-id="${c.id}">Reject</button></div></div>`).join(''):'<p class="mono">No campaigns waiting for review.</p>';
    $('adminCampaigns').querySelectorAll('[data-review]').forEach(b=>b.addEventListener('click',()=>reviewCampaign(b.dataset.id,b.dataset.review,b)));
    $('adminUsers').innerHTML=tableHTML(['Name','Email','Joined'],users.data.map(u=>`<tr><td>${escapeHTML(u.full_name||'—')}</td><td>${escapeHTML(u.email)}</td><td>${new Date(u.created_at).toLocaleDateString()}</td></tr>`));
    $('adminIdeas').innerHTML=tableHTML(['Idea','User ID','Created'],ideas.data.map(i=>`<tr><td>${escapeHTML(i.title)}</td><td>${escapeHTML(i.user_id)}</td><td>${new Date(i.created_at).toLocaleDateString()}</td></tr>`));
    $('adminAIDocs').innerHTML=tableHTML(['Document','Type','User ID','Created'],aiDocs.data.map(d=>`<tr><td>${escapeHTML(d.title||'')}</td><td>${escapeHTML(d.kind)}</td><td>${escapeHTML(d.user_id)}</td><td>${new Date(d.created_at).toLocaleDateString()}</td></tr>`));
    $('adminLeads').innerHTML=tableHTML(['Name','Email','Type','Message'],leads.data.map(l=>`<tr><td>${escapeHTML(l.name)}</td><td>${escapeHTML(l.email)}</td><td>${escapeHTML(l.request_type)}</td><td>${escapeHTML(l.message.slice(0,160))}</td></tr>`));
    window.__launchglassAdminData={users:users.data,ideas:ideas.data,ai_documents:aiDocs.data,campaigns:campaigns.data,leads:leads.data,campaign_interests:interests.data};
  } catch(e){notify('Owner console could not load: '+e.message);}
}
async function reviewCampaign(id,status,button){
  setBusy(button,true,'Updating…');
  try{const {error}=await supabase.rpc('admin_review_campaign',{p_campaign_id:id,p_status:status});if(error)throw error;notify('Campaign marked '+status+'.');await loadAdmin();await loadPublicCampaigns();}
  catch(e){notify(e.message);}
  finally{setBusy(button,false);}
}
$('refreshAdmin')?.addEventListener('click',loadAdmin);
async function fetchAllRows(table, columns='*', orderColumn='created_at') {
  const all=[]; let start=0; const pageSize=500;
  while(true){
    const {data,error}=await supabase.from(table).select(columns).order(orderColumn,{ascending:false}).range(start,start+pageSize-1);
    if(error)throw error;
    all.push(...data);
    if(data.length<pageSize)break;
    start+=pageSize;
  }
  return all;
}
$('exportAllData')?.addEventListener('click',async()=>{
  if(!(await requireClient()))return;
  const b=$('exportAllData');setBusy(b,true,'Preparing export…');
  try{
    const [users,ideas,aiDocs,campaigns,interests,leads]=await Promise.all([
      fetchAllRows('profiles','id,email,full_name,created_at'),fetchAllRows('ideas'),fetchAllRows('ai_documents'),
      fetchAllRows('campaigns'),fetchAllRows('campaign_interests'),fetchAllRows('leads')
    ]);
    downloadJSON('launchglass-platform-export-'+new Date().toISOString().slice(0,10)+'.json',{users,ideas,ai_documents:aiDocs,campaigns,campaign_interests:interests,leads});
  }catch(e){notify('Export failed: '+e.message);}
  finally{setBusy(b,false);}
});
$('exportMyData')?.addEventListener('click',async()=>{
  if(!(await requireClient()))return;
  try{
    const [profile,ideas,campaigns,interests,leads,aiDocs]=await Promise.all([
      supabase.from('profiles').select('id,email,full_name,created_at').eq('id',currentUser.id).maybeSingle(),
      fetchAllRows('ideas'),fetchAllRows('campaigns'),fetchAllRows('campaign_interests'),
      fetchAllRows('leads').then(rows=>rows.filter(row=>row.user_id===currentUser.id)),fetchAllRows('ai_documents')
    ]);
    if(profile.error)throw profile.error;
    downloadJSON('my-launchglass-data-'+new Date().toISOString().slice(0,10)+'.json',{profile:profile.data,ideas,ai_documents:aiDocs,campaigns:campaigns.filter(row=>row.user_id===currentUser.id),interests,enquiries:leads});
  }catch(e){notify('Export failed: '+e.message);}
});


// PHASE 3 — Manufacturer portal: verified directory, partner applications,
// creator RFQs and manufacturer quotations. All writes use Supabase RLS.
function showMfgResult(id,text){const el=$(id);if(el){el.textContent=text;el.classList.add('show');}}
async function loadManufacturerDirectory(){
 const box=$('manufacturerDirectory');if(!box||!supabase)return;
 box.innerHTML='<p class="mono">Loading verified partners…</p>';
 try{
  const {data,error}=await supabase.from('manufacturer_profiles')
   .select('id,user_id,business_name,location,categories,capabilities,minimum_order_quantity,website,created_at')
   .eq('status','verified').order('created_at',{ascending:false}).limit(100);
  if(error)throw error;
  const q=($('manufacturerSearch')?.value||'').trim().toLowerCase();
  const rows=(data||[]).filter(x=>!q||[x.business_name,x.location,x.categories,x.capabilities].some(v=>String(v||'').toLowerCase().includes(q)));
  box.innerHTML=rows.length?rows.map(x=>`<article class="manufacturerCard"><h4>${escapeHTML(x.business_name)}</h4><div class="manufacturerMeta"><span>VERIFIED LISTING</span><span>${escapeHTML(x.location)}</span><span>MOQ ${Number(x.minimum_order_quantity||1).toLocaleString('en-IN')}</span></div><p><b>Categories:</b> ${escapeHTML(x.categories)}</p><p>${escapeHTML(x.capabilities)}</p>${x.website?`<p><a href="${escapeHTML(x.website)}" target="_blank" rel="noopener noreferrer">Business website</a></p>`:''}<button class="btn" type="button" data-contact-mfg="${x.id}">Request a quote</button></article>`).join(''):'<p class="mono">No verified manufacturers are listed yet. Business applications remain private until owner review.</p>';
  box.querySelectorAll('[data-contact-mfg]').forEach(b=>b.addEventListener('click',()=>{const select=$('mfgRequestCategory');if(select)select.focus();$('mfgRequestDescription').focus();notify('Complete the quotation request below. Verified partners can respond to open requests.');}));
 }catch(e){box.innerHTML=`<p class="mono">Directory unavailable: ${escapeHTML(e.message)}</p>`;}
}
async function loadMyManufacturerProfile(){
 if(!supabase||!currentUser)return;
 const {data,error}=await supabase.from('manufacturer_profiles').select('*').eq('user_id',currentUser.id).maybeSingle();
 if(error){console.warn('Manufacturer profile:',error.message);return;}
 if(!data)return;
 $('mfgBusinessName').value=data.business_name||'';$('mfgLocation').value=data.location||'';
 $('mfgCategories').value=data.categories||'';$('mfgMoq').value=data.minimum_order_quantity||'';
 $('mfgCapabilities').value=data.capabilities||'';$('mfgWebsite').value=data.website||'';
 showMfgResult('manufacturerProfileStatus',`Application status: ${data.status}. ${data.review_note||'Your listing is not public until verified.'}`);
}
$('saveManufacturerProfile')?.addEventListener('click',async()=>{
 if(!(await requireClient()))return;
 const business_name=$('mfgBusinessName').value.trim(),location=$('mfgLocation').value.trim(),categories=$('mfgCategories').value.trim(),capabilities=$('mfgCapabilities').value.trim(),minimum_order_quantity=Number($('mfgMoq').value),raw=$('mfgWebsite').value.trim();
 if(business_name.length<2||location.length<2||categories.length<2||capabilities.length<40||!Number.isInteger(minimum_order_quantity)||minimum_order_quantity<1){showMfgResult('manufacturerProfileStatus','Complete business name, location, categories, at least 40 characters of capabilities and a valid MOQ.');return;}
 let website=null;if(raw){try{const u=new URL(raw);if(!['https:','http:'].includes(u.protocol))throw 0;website=u.href;}catch{showMfgResult('manufacturerProfileStatus','Enter a valid website URL.');return;}}
 const b=$('saveManufacturerProfile');setBusy(b,true,'Submitting…');
 try{
  const payload={user_id:currentUser.id,business_name,location,categories,capabilities,minimum_order_quantity,website,status:'pending'};
  const {error}=await supabase.from('manufacturer_profiles').upsert(payload,{onConflict:'user_id'});
  if(error)throw error;
  showMfgResult('manufacturerProfileStatus','Business profile submitted. It is private and awaiting owner verification.');notify('Manufacturer application submitted for review.');
 }catch(e){showMfgResult('manufacturerProfileStatus','Could not submit: '+e.message);}
 finally{setBusy(b,false);}
});
$('createMfgRequest')?.addEventListener('click',async()=>{
 if(!(await requireClient()))return;
 const campaign_id=$('mfgRequestCampaign').value||null,category=$('mfgRequestCategory').value,quantity=Number($('mfgRequestQuantity').value),needed_by=$('mfgRequestDeadline').value||null,description=$('mfgRequestDescription').value.trim();
 if(!category||!Number.isInteger(quantity)||quantity<1||description.length<40){showMfgResult('mfgRequestStatus','Choose a category, enter a positive quantity and describe the requirements in at least 40 characters.');return;}
 const b=$('createMfgRequest');setBusy(b,true,'Sending request…');
 try{const {error}=await supabase.from('manufacturing_requests').insert({creator_id:currentUser.id,campaign_id,category,quantity,needed_by,description});
  if(error)throw error;showMfgResult('mfgRequestStatus','Quotation request created. Verified manufacturers can now review it.');$('mfgRequestDescription').value='';await loadManufacturingPortal();notify('Manufacturing request saved.');
 }catch(e){showMfgResult('mfgRequestStatus','Could not create request: '+e.message);}
 finally{setBusy(b,false);}
});
async function loadManufacturingPortal(){
 if(!supabase||!currentUser)return;
 await loadMyManufacturerProfile();
 const {data:campaigns,error:ce}=await supabase.from('campaigns').select('id,name').eq('user_id',currentUser.id).order('created_at',{ascending:false}).limit(50);
 if(!ce){$('mfgRequestCampaign').innerHTML='<option value="">No linked campaign</option>'+(campaigns||[]).map(c=>`<option value="${c.id}">${escapeHTML(c.name)}</option>`).join('');}
 const {data:profile}=await supabase.from('manufacturer_profiles').select('status').eq('user_id',currentUser.id).maybeSingle();
 const isVerified=profile?.status==='verified';
 const reqBox=$('mfgRequestsList');
 try{
  let query=supabase.from('manufacturing_requests').select('id,creator_id,campaign_id,category,quantity,needed_by,description,status,created_at').eq('status','open').order('created_at',{ascending:false}).limit(100);
  const {data,error}=await query;if(error)throw error;
  const requests=(data||[]).filter(r=>r.creator_id===currentUser.id||isVerified);
  reqBox.innerHTML=requests.length?requests.map(r=>`<article class="manufacturerCard"><h4>${escapeHTML(r.category)} · ${Number(r.quantity).toLocaleString('en-IN')} units</h4><div class="manufacturerMeta"><span>${r.creator_id===currentUser.id?'YOUR REQUEST':'OPEN RFQ'}</span><span>${new Date(r.created_at).toLocaleDateString('en-IN')}</span>${r.needed_by?`<span>NEEDED BY ${escapeHTML(r.needed_by)}</span>`:''}</div><p>${escapeHTML(r.description)}</p>${isVerified&&r.creator_id!==currentUser.id?`<button class="btn primary" data-quote-request="${r.id}">Submit quotation</button>`:''}</article>`).join(''):'<p class="mono">${isVerified?'No open quotation requests yet.':'Your requests appear here. Only verified manufacturers can view other creators’ open requests.'}</p>';
  reqBox.querySelectorAll('[data-quote-request]').forEach(b=>b.addEventListener('click',()=>openQuoteForm(b.dataset.quoteRequest)));
 }catch(e){reqBox.innerHTML=`<p class="mono">Requests unavailable: ${escapeHTML(e.message)}</p>`;}
 const {data:mine,error:me}=await supabase.from('manufacturing_requests').select('id,category,quantity,status,created_at').eq('creator_id',currentUser.id).order('created_at',{ascending:false}).limit(30);
 const {data:quotes,error:qe}=await supabase.from('manufacturing_quotes').select('id,request_id,manufacturer_id,price_per_unit,currency,lead_time_days,notes,status,created_at').eq('manufacturer_id',currentUser.id).order('created_at',{ascending:false}).limit(30);
 if(me||qe){$('myMfgActivity').textContent='Activity could not load: '+(me||qe).message;return;}
 $('myMfgActivity').innerHTML=[...(mine||[]).map(x=>`<div class="workspaceItem"><div><strong>Request · ${escapeHTML(x.category)}</strong><small>${Number(x.quantity)} units · ${escapeHTML(x.status)} · ${new Date(x.created_at).toLocaleDateString()}</small></div></div>`),...(quotes||[]).map(x=>`<div class="workspaceItem"><div><strong>Quotation · ${escapeHTML(x.currency)} ${Number(x.price_per_unit).toLocaleString('en-IN')} / unit</strong><small>${Number(x.lead_time_days)} days · ${escapeHTML(x.status)} · ${escapeHTML(x.notes||'')}</small></div></div>`)].join('')||'<p class="mono">No manufacturing activity yet.</p>';
}
function openQuoteForm(requestId){
 const price=prompt('Your quoted price per unit (numbers only):');if(price===null)return;
 const lead=prompt('Estimated lead time in days:');if(lead===null)return;
 const notes=prompt('Quote notes, exclusions and assumptions:')||'';
 submitManufacturingQuote(requestId,Number(price),Number(lead),notes);
}
async function submitManufacturingQuote(request_id,price_per_unit,lead_time_days,notes){
 if(!(await requireClient()))return;
 if(!Number.isFinite(price_per_unit)||price_per_unit<=0||!Number.isInteger(lead_time_days)||lead_time_days<1){notify('Enter a valid positive unit price and lead time.');return;}
 try{const {error}=await supabase.from('manufacturing_quotes').insert({request_id,manufacturer_id:currentUser.id,price_per_unit,currency:'INR',lead_time_days,notes:String(notes).slice(0,1500)});if(error)throw error;notify('Quotation submitted to the creator.');await loadManufacturingPortal();}
 catch(e){notify('Quote failed: '+e.message);}
}
$('refreshManufacturers')?.addEventListener('click',loadManufacturerDirectory);
$('manufacturerSearch')?.addEventListener('input',loadManufacturerDirectory);
$('refreshMfgRequests')?.addEventListener('click',loadManufacturingPortal);

// Route dashboard role tabs to their real working areas; hide admin access for non-owners.
document.querySelectorAll('.roleTab').forEach(button=>button.addEventListener('click',()=>{
  const role=button.dataset.role;
  if(role==='creator'){location.hash='#my-workspace';}
  if(role==='backer'){location.hash='#product-discovery';}
  if(role==='manufacturer'){location.hash='#manufacturing';loadManufacturingPortal();}
  if(role==='admin'){
    if($('owner-console').hidden){notify('Owner access only.');return;}
    location.hash='#owner-console';
  }
}));

// The contact modal's old local-only message is superseded by the database-backed submit handler above.
window.addEventListener('error', event => console.error('Launchglass:',event.message));

// Additional AI tools: each runs through the same authenticated, server-side Gemini Edge Function.
const aiToolCard = document.querySelector('#ai-workbench .grid3 .infoCard');
if (aiToolCard) {
  const extra = document.createElement('div');
  extra.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;margin-top:10px';
  extra.innerHTML = '<button class="btn" type="button" data-ai-action="marketing_plan">Marketing plan</button><button class="btn" type="button" data-ai-action="pricing_plan">Pricing worksheet</button><button class="btn" type="button" data-ai-action="launch_checklist">Launch checklist</button>';
  aiToolCard.append(extra);
  const result = document.createElement('div'); result.id='extraAIResult'; result.className='resultBox'; aiToolCard.append(result);
  extra.querySelectorAll('[data-ai-action]').forEach(button=>button.addEventListener('click',async()=>{
    const title=$('ideaTitle').value.trim(),description=$('ideaDescription').value.trim();
    if(description.length<20){notify('Enter your idea in the Idea Analyzer first.');return;}
    setBusy(button,true,'Generating…');result.textContent='Gemini is preparing your document…';result.classList.add('show');
    try{result.textContent=await runGemini(button.dataset.aiAction,title,description);await saveAIDocument(button.dataset.aiAction,title,description,result.textContent);notify('AI document saved to your workspace.');await loadWorkspace();}
    catch(e){result.textContent=e.message;}
    finally{setBusy(button,false);}
  }));
}

// Restore an existing draft into the editor, or remove a user's own idea/draft.
function attachWorkspaceActions() {
  document.querySelectorAll('[data-open-ai-doc]').forEach(button=>button.addEventListener('click',async()=>{const {data,error}=await supabase.from('ai_documents').select('title,kind,content').eq('id',button.dataset.openAiDoc).single();if(error){notify(error.message);return;}const w=window.open('','_blank');if(w){w.opener=null;w.document.write('<title>'+escapeHTML(data.title)+'</title><pre style="white-space:pre-wrap;font:14px system-ui;padding:24px;max-width:900px;margin:auto">'+escapeHTML(data.content)+'</pre>');w.document.close();}}));
  document.querySelectorAll('[data-edit-campaign]').forEach(button=>button.addEventListener('click',async()=>{
    const id=button.dataset.editCampaign;
    const {data,error}=await supabase.from('campaigns').select('*').eq('id',id).single();
    if(error){notify(error.message);return;}
    currentCampaignId=data.id;
    $('campaignName').value=data.name; $('campaignStory').value=data.story;
    $('campaignGoal').value=data.goal; $('campaignDays').value=data.duration_days;
    $('campaignReward').value=data.reward||''; $('campaignCategory').value=data.category;
    window.launchglassCampaignImageUrl=data.image_url||null; if($('campaignImagePreview')){$('campaignImagePreview').src=data.image_url||'';$('campaignImagePreview').hidden=!data.image_url;}
    location.hash='#campaign-builder'; notify('Draft loaded into the campaign builder.');
  }));
  document.querySelectorAll('[data-delete-idea]').forEach(button=>button.addEventListener('click',async()=>{
    if(!confirm('Delete this saved idea?'))return;
    const {error}=await supabase.from('ideas').delete().eq('id',button.dataset.deleteIdea);
    if(error)notify(error.message);else{notify('Idea deleted.');await loadWorkspace();}
  }));
  document.querySelectorAll('[data-delete-campaign]').forEach(button=>button.addEventListener('click',async()=>{
    if(!confirm('Delete this draft?'))return;
    const {error}=await supabase.from('campaigns').delete().eq('id',button.dataset.deleteCampaign);
    if(error)notify(error.message);else{notify('Draft deleted.');await loadWorkspace();}
  }));
}
const originalLoadWorkspace = loadWorkspace;
loadWorkspace = async function(){
  await originalLoadWorkspace();
  if(!supabase||!currentUser)return;
  const [ideasRes,campaignsRes]=await Promise.all([
    supabase.from('ideas').select('id,title,description,created_at').order('created_at',{ascending:false}).limit(50),
    supabase.from('campaigns').select('id,name,goal,category,status,duration_days,story,reward,created_at').order('created_at',{ascending:false}).limit(50)
  ]);
  if(!ideasRes.error){
    $('myIdeas').innerHTML=ideasRes.data.length?ideasRes.data.map(x=>`<div class="workspaceItem"><div><strong>${escapeHTML(x.title)}</strong><small>${new Date(x.created_at).toLocaleDateString()} · ${escapeHTML(x.description.slice(0,80))}</small></div><button class="btn" data-delete-idea="${x.id}" type="button">Delete</button></div>`).join(''):'<p class="mono">No saved ideas yet.</p>';
  }
  if(!campaignsRes.error){
    $('myCampaigns').innerHTML=campaignsRes.data.length?campaignsRes.data.map(x=>`<div class="workspaceItem"><div><strong>${escapeHTML(x.name)}</strong><small>₹${Number(x.goal).toLocaleString('en-IN')} · ${escapeHTML(x.category)} · ${escapeHTML(x.status)}</small></div><div class="actionRow">${x.status==='draft'?`<button class="btn" data-edit-campaign="${x.id}" type="button">Edit</button><button class="btn" data-delete-campaign="${x.id}" type="button">Delete</button>`:''}<span class="statusPill">${escapeHTML(x.status)}</span></div></div>`).join(''):'<p class="mono">No campaigns yet.</p>';
  }
  attachWorkspaceActions();
};

// Re-run the enriched workspace renderer after module initialization/session restore.
if (currentUser) loadWorkspace();

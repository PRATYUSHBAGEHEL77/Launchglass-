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
  return {name,story,goal,duration_days:days,reward,category};
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

async function loadPublicCampaigns() {
  if(!supabase) return;
  const box=$('liveCampaigns');
  try {
    const {data,error}=await supabase.from('campaigns').select('id,name,story,goal,duration_days,category,created_at').eq('status','approved').order('created_at',{ascending:false}).limit(18);
    if(error) throw error;
    if(!data.length){box.innerHTML='<p class="mono">No approved community campaigns yet. Submitted campaigns appear here after owner review.</p>';return;}
    box.innerHTML=data.map(c=>`<article class="liveCampaignCard"><span class="chip">${escapeHTML(c.category)}</span><h3>${escapeHTML(c.name)}</h3><p>${escapeHTML(c.story.slice(0,190))}${c.story.length>190?'…':''}</p><div class="mono">GOAL · ₹${Number(c.goal).toLocaleString('en-IN')} · ${c.duration_days} DAYS</div><button class="btn primary" data-follow-campaign="${c.id}" type="button">Follow campaign</button></article>`).join('');
    box.querySelectorAll('[data-follow-campaign]').forEach(button=>button.addEventListener('click',()=>toggleInterest(button.dataset.followCampaign,button)));
  } catch(e){box.innerHTML='<p class="mono">Campaigns could not be loaded. Check the Supabase table setup.</p>';}
}
async function toggleInterest(campaignId,button) {
  if(!(await requireClient())) return;
  setBusy(button,true,'Saving…');
  try {
    const {data,error}=await supabase.from('campaign_interests').select('id').eq('campaign_id',campaignId).eq('user_id',currentUser.id).maybeSingle();
    if(error) throw error;
    if(data){const del=await supabase.from('campaign_interests').delete().eq('id',data.id);if(del.error)throw del.error;notify('Removed from your followed campaigns.');}
    else {const ins=await supabase.from('campaign_interests').insert({campaign_id:campaignId,user_id:currentUser.id});if(ins.error)throw ins.error;notify('Campaign added to your workspace.');}
    await loadWorkspace();
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

// Route dashboard role tabs to their real working areas; hide admin access for non-owners.
document.querySelectorAll('.roleTab').forEach(button=>button.addEventListener('click',()=>{
  const role=button.dataset.role;
  if(role==='creator'){location.hash='#my-workspace';}
  if(role==='backer'){location.hash='#product-discovery';}
  if(role==='manufacturer'){$('leadType').value='manufacturer';window.openModal?.('manufacturer');}
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

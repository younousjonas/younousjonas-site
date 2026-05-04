
function cfg(){return window.YJ_CONFIG || {}};
function setLinks(){
  const c=cfg();
  document.querySelectorAll('[data-email]').forEach(a=>{a.href='mailto:'+c.email; a.textContent=c.email});
  document.querySelectorAll('[data-lemalokisme]').forEach(a=>a.href=c.leMalokismeUrl);
  document.querySelectorAll('[data-komsa]').forEach(a=>a.href=c.komsaReUrl);
  document.querySelectorAll('[data-amazon-broche]').forEach(a=>a.href=c.amazonBrocheUrl);
  document.querySelectorAll('[data-amazon-relie]').forEach(a=>a.href=c.amazonRelieUrl);
}
function initForm(){
  const form=document.querySelector('#contact-form');
  if(!form)return;
  form.addEventListener('submit', async (e)=>{
    e.preventDefault();
    const c=cfg();
    const data=Object.fromEntries(new FormData(form).entries());
    const body=encodeURIComponent(`Bonjour Younous,%0D%0A%0D%0AJe viens depuis YounousJonas.com.%0D%0A%0D%0APrénom / nom : ${data.name||''}%0D%0AEmail : ${data.email||''}%0D%0ATéléphone : ${data.phone||''}%0D%0ASujet : ${data.subject||''}%0D%0A%0D%0AMessage :%0D%0A${data.message||''}`);
    if(c.makeWebhookUrl){
      try{ await fetch(c.makeWebhookUrl,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...data,source:'younousjonas.com'})}); }catch(err){}
    }
    window.location.href=`mailto:${c.email}?subject=${encodeURIComponent('Contact depuis YounousJonas.com - '+(data.subject||''))}&body=${body}`;
  });
}
document.addEventListener('DOMContentLoaded',()=>{setLinks();initForm();});

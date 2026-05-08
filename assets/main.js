
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
  const status=document.getElementById('formStatus');
  form.addEventListener('submit', async (e)=>{
    e.preventDefault();
    const formData=new FormData(form);
    if(status) status.textContent='Envoi en cours…';
    try{
      const response=await fetch('/', {
        method:'POST',
        headers:{'Content-Type':'application/x-www-form-urlencoded'},
        body:new URLSearchParams(formData).toString()
      });
      if(!response.ok) throw new Error('HTTP '+response.status);
      if(status) status.textContent='Message envoyé. Je lis et je réponds personnellement.';
      form.reset();
    }catch(err){
      if(status) status.textContent='L’envoi n’a pas fonctionné. Écris directement à hello@younousjonas.com.';
    }
  });
}
document.addEventListener('DOMContentLoaded',()=>{setLinks();initForm();});

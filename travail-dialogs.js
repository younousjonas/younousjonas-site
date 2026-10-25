let entryButton=null;
const panels=[...document.querySelectorAll('dialog')];
document.querySelectorAll('[data-open]').forEach(button=>button.addEventListener('click',()=>{
 const target=document.getElementById(button.dataset.open);
 if(!button.closest('dialog'))entryButton=button;
 panels.filter(panel=>panel.open).forEach(panel=>panel.close());
 target.showModal();
}));
panels.forEach(panel=>{
 panel.querySelector('[data-close]').addEventListener('click',()=>panel.close());
 panel.addEventListener('close',()=>{if(!panels.some(item=>item.open))entryButton?.focus();});
 panel.addEventListener('click',event=>{
  if(event.target!==panel)return;
  const rect=panel.getBoundingClientRect();
  if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)panel.close();
 });
});
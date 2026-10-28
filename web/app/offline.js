// Silent offline setup: no readiness badge is added to the editor UI.
if('serviceWorker' in navigator&&window.isSecureContext&&window.top===window){
 const controlled=()=>{if(navigator.serviceWorker.controller)document.body.dataset.offlineReady='true';};
 navigator.serviceWorker.addEventListener('controllerchange',controlled);
 navigator.serviceWorker.register(new URL('./sw.js',import.meta.url),{updateViaCache:'none'})
  .then(()=>navigator.serviceWorker.ready).then(controlled)
  .catch(error=>console.warn('Suhjae offline cache could not be installed:',error));
}

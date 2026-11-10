const {chromium}=await import(process.env.PLAYWRIGHT_MODULE??new URL('../tools/browser-qualification/node_modules/playwright-core/index.mjs',import.meta.url).href);
const {default:AxeBuilder}=await import(process.env.AXE_MODULE??new URL('../tools/browser-qualification/node_modules/@axe-core/playwright/dist/index.mjs',import.meta.url).href);
import {readFileSync} from 'node:fs';
const code=readFileSync(new URL('../src/groove-reveal.mjs',import.meta.url),'utf8');
const browser=await chromium.launch({...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{}),headless:true,args:['--no-sandbox']});
try {
const context=await browser.newContext({viewport:{width:390,height:844}});
const page=await context.newPage();
const errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.setContent('<!doctype html><html lang="en"><title>Groove reveal test</title><main><h1>Live radio</h1><button id="playing">Stop live radio</button><div id="reveal"></div></main></html>');
await page.evaluate(async code=>{
 const module=await import(URL.createObjectURL(new Blob([code],{type:'text/javascript'})));
 const style=document.createElement('style');style.textContent=module.grooveRevealCss;document.head.append(style);
 window.view=module.mountGrooveReveal(document.querySelector('#reveal'));document.querySelector('#playing').focus();
 window.view.update({phase:'LOCKED'});
},code);
await page.getByRole('status').filter({hasText:'LOCKED GROOVE'}).waitFor();
if(await page.locator('#playing').evaluate(node=>node!==document.activeElement))throw Error('Focus moved');
await page.evaluate(()=>window.view.update({phase:'UNLOCKED'}));
await page.getByRole('status').filter({hasText:'UNLOCKED GROOVE'}).waitFor();
const motion=await page.getByRole('status').evaluate(node=>getComputedStyle(node).animationName);
if(motion!=='groove-unlock')throw Error('Expected unlock animation');
await page.emulateMedia({reducedMotion:'reduce'});
const reduced=await page.getByRole('status').evaluate(node=>({animation:getComputedStyle(node).animationName,live:node.getAttribute('aria-live'),atomic:node.getAttribute('aria-atomic')}));
if(reduced.animation!=='none'||reduced.live!=='polite'||reduced.atomic!=='true')throw Error('Accessible reduced-motion announcement failed');
if(await page.locator('body').evaluate(node=>node.scrollWidth>innerWidth))throw Error('Mobile overflow');
if(process.env.QUALIFICATION_SCREENSHOT_PATH)await page.screenshot({path:process.env.QUALIFICATION_SCREENSHOT_PATH});
const axe=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
if(axe.violations.length)throw Error(JSON.stringify(axe.violations.map(x=>({id:x.id,impact:x.impact,nodes:x.nodes.map(n=>n.target)}))));
await page.emulateMedia({forcedColors:'active'});await page.getByRole('status').waitFor();
if(errors.length)throw Error(errors.join('\n'));
console.log(JSON.stringify({browser:await browser.version(),viewport:'390x844',normalAnimation:motion,reducedMotion:reduced,focusRetained:true,mobileOverflow:false,forcedColors:true,pageErrors:errors.length,axeViolations:axe.violations.length,scope:'DOM fixture only; no media/provider/hardware qualification'}));
} finally {await browser.close();}

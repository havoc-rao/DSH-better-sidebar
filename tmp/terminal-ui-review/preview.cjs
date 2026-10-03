const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { chromium } = require('playwright');
(async () => {
const dir = __dirname;
await esbuild.build({
 stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import {WorkspaceTerminals} from './src/client/WorkspaceTerminals.tsx';
 const snapshot={sessionId:'demo',state:{}};
 const store={subscribe:()=>()=>{},getSnapshot:()=>snapshot,getSessionStates:()=>new Map()};
 createRoot(document.getElementById('root')).render(<WorkspaceTerminals sessionId="demo" store={store}/>);`, resolveDir: process.cwd(), loader:'tsx' },
 bundle:true, outfile:path.join(dir,'app.js'), jsx:'automatic', plugins:[{name:'preview-data',setup(build){
 build.onResolve({filter:/^(\.\/api\.ts|\.\/workspace-terminals\.ts|\.\/locales\.ts|@deepseek-ai\/dsh-client-ui-primitives)$/}, args=>({path:args.path,namespace:'preview'}));
 build.onLoad({filter:/.*/,namespace:'preview'}, args=>({contents: args.path.includes('workspace-terminals') ? 'export const updateTerminalSession=()=>{}; export const refreshWorkspaceTerminalTabs=()=>{}; export const openWorkspaceTerminal=()=>{};' : args.path.includes('api.ts') ? `export const api={workspaceTerminalList:async()=>({terminals:[{terminalId:'one',title:'开发服务器 · pnpm dev',cwd:'/Users/havoc/Documents/Projects/DSH-better-sidebar',createdBySessionId:'frontend-session',exited:false},{terminalId:'two',title:'very-long-build-task-with-a-name-that-must-not-overflow-the-panel',cwd:'/workspace/services/backend',createdBySessionId:'backend-session',exited:false},{terminalId:'three',title:'类型检查',cwd:'/workspace',createdBySessionId:'checks-session',exited:true,exitCode:0}]}),workspaceTerminalTerminate:async()=>{}};` : args.path.includes('locales') ? `const labels={workspaceTerminals:'工作区终端',workspaceTerminalRunning:'运行中',workspaceTerminalExited:'已退出',workspaceTerminalDetachHint:'关闭标签页只会断开视图，终端仍在后台运行。',workspaceTerminalOpen:'打开',workspaceTerminalTerminate:'终止',workspaceTerminalTerminateConfirm:'终止后将关闭终端进程，此操作不可撤销。',refresh:'刷新',cancel:'取消',loading:'加载中',workspaceTerminalEmpty:'暂无工作区终端'}; export const t=k=>labels[k]||k;` : `import React from 'react'; export const FileTypeIcon=()=>null; export const IconRefreshOutlineRegular=()=>React.createElement('svg',{width:16,height:16,viewBox:'0 0 16 16'},React.createElement('path',{d:'M13 7a5 5 0 1 0-1 4M13 3v4H9',stroke:'currentColor',fill:'none'}));`,loader:'js',resolveDir:process.cwd()}));
 }}]
});
const prior=fs.readFileSync('tmp/workspace-terminals-preview.html','utf8');
const tokens=prior.match(/<style>([\s\S]*?)<\/style>/)[1];
const browser=await chromium.launch({headless:true});
const page=await browser.newPage({viewport:{width:760,height:480},deviceScaleFactor:2});
await page.setContent(`<html lang="zh-CN" data-theme="dark"><style>${tokens}\nhtml,body{margin:0;padding:0;width:100%;height:100%;display:block} #root{height:100%;width:100%}</style><style>${fs.readFileSync(path.join(dir,'app.css'),'utf8')}</style><div id="root"></div></html>`);
await page.addScriptTag({content:fs.readFileSync(path.join(dir,'app.js'),'utf8')});
await page.waitForSelector('[data-terminal-id]');
await page.screenshot({path:path.join(dir,'wide-dark.png')});
await page.setViewportSize({width:320,height:640});
await page.screenshot({path:path.join(dir,'narrow-dark.png')});
await page.locator('button[aria-expanded]').first().click();
await page.screenshot({path:path.join(dir,'confirmation-dark.png')});
await page.evaluate(()=>document.documentElement.dataset.theme='light');
await page.screenshot({path:path.join(dir,'narrow-light.png')});
console.log('Horizontal overflow:',await page.evaluate(()=>document.querySelector('section').scrollWidth>document.querySelector('section').clientWidth));
await browser.close();
})();

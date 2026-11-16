import { test, expect } from '@playwright/test';
import { startStubServer } from './stub-server.mjs';
test.use({ browserName: process.env.PS_TEST_BROWSER || 'chromium' });
let stub, base;
test.beforeEach(async () => { stub = await startStubServer(0, { sessionCount: 2 }); base = `http://127.0.0.1:${stub.port}`; });
test.afterEach(async ({ page }) => {
 await page.close();
 const closed = new Promise(resolve => {
  stub.server.close(resolve);
  stub.server.closeAllConnections();
 });
 await page.request.dispose();
 await closed;
});
for (const mobile of [false, true]) {
 for (const explicit of [undefined, false, true]) {
  test(`${mobile ? 'mobile' : 'desktop'} scale respects own preference ${explicit}`, async ({ page }) => {
   const own = mobile ? 'touchScaleMobile' : 'touchScale';
   const other = mobile ? 'touchScale' : 'touchScaleMobile';
   let settings = { themeId: 'terminal-green', [other]: !mobile, ...(explicit === undefined ? {} : { [own]: explicit }) };
   await page.route('**/api/v1/**', async route => {
    const req=route.request(), path=new URL(req.url()).pathname;
    const reply=result=>route.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,result})});
    if(path.endsWith('/me/profile/settings')) { settings=req.postDataJSON().settings; return reply({profileSettings:settings}); }
    if(path.endsWith('/me/profile')) return reply({isAdmin:false,profileSettings:settings});
    return route.fallback();
   });
   await page.setViewportSize({width:mobile ? 390 : 1440,height:900});
   await page.goto(base);
   await page.getByRole('button',{name:'Theme',exact:true}).click();
   const checkbox=page.getByRole('checkbox',{name:'Mobile',exact:true});
   await expect(checkbox).toBeChecked({checked:explicit ?? mobile});
   await checkbox.setChecked(!(explicit ?? mobile));
   await expect.poll(()=>settings[own]).toBe(!(explicit ?? mobile));
   expect(settings[other]).toBe(!mobile);
   await page.reload();
   await page.getByRole('button',{name:'Theme',exact:true}).click();
   await expect(page.getByRole('checkbox',{name:'Mobile',exact:true})).toBeChecked({checked:!(explicit ?? mobile)});
  });
 }
}

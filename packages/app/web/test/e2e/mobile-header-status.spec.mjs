import { test, expect } from '@playwright/test';
import { startStubServer } from './stub-server.mjs';

test.use({ browserName: process.env.PS_TEST_BROWSER || 'chromium' });

const sessionId = '11111110-2222-3333-4444-555555555550';
const T0 = 1785000000000;
for (const mode of ['zen', 'moa']) for (const themeId of ['terminal-green', 'win95', 'winamp', 'ms-dos']) {
    test(`mobile ${mode} header replaces footer without layout jumps: ${themeId}`, async ({ page }) => {
        const stub = await startStubServer(0, { sessionCount: 1, transcriptTurns: 5, themeId });
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        let snapshot = { status: 'idle', statusVersion: 6, updatedAt: T0 };
        let reads = 0, sends = 0, releaseStop, releaseSteer;
        const stops = [], steers = [];
        // acceptsTurnControl: the running turn listens for Stop/Steer; the
        // composer offers Steer only while the session is also running.
        const row = () => ({ sessionId, title: themeId === 'ms-dos' ? '' : 'Footer regression', model: 'github-copilot:claude-sonnet-5',
            owner: { provider: 'none', subject: 'test', email: 'test@example.com', displayName: 'Test User' },
            createdAt: T0, acceptsTurnControl: true, ...snapshot });
        try {
            await page.route('**/api/v1/**', async route => {
                const request = route.request(), path = new URL(request.url()).pathname;
                const answer = result => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, result }) });
                if (path.endsWith('/me/profile')) return answer({isAdmin:false,profileSettings:{themeId,moa:{version:2,tree:{id:'header-panel',type:'chat',sessionId},aspectRatio:2}}});
                if (path.endsWith('/management/sessions')) {
                    reads += 1;
                    return answer({ sessions: [row()], hasMore: false });
                }
                if (path.endsWith(`/sessions/${sessionId}`)) return answer(row());
                if (path.endsWith(`/sessions/${sessionId}/messages`)) { sends += 1; return answer({ queued: true }); }
                if (path.endsWith('/management/users/me/features')) return answer({ userId: 1, flags: [{ featureKey: 'sessions.steering', effective: true }] });
                if (path.endsWith('/steer')) {
                    steers.push({ path, body: request.postDataJSON() });
                    await new Promise(resolve => { releaseSteer = resolve; });
                    return answer({ outcome: 'too_many' });
                }
                if (path.endsWith('/stop-turn')) {
                    stops.push({ path, body: request.postDataJSON() });
                    await new Promise(resolve => { releaseStop = resolve; });
                    snapshot = { status: 'idle', statusVersion: 10, updatedAt: T0 + 10000 };
                    return answer({ outcome: 'stopped' });
                }
                return route.fallback();
            });
            await page.setViewportSize({ width: 390, height: 844 });
            await page.goto(`http://127.0.0.1:${stub.port}/?session=${sessionId}`);
            await page.getByRole('button',{name:mode==='zen'?'Enter mobile zen':'Master of Agents',exact:true}).click();
            const surface=page.locator(mode==='zen'?'.ps-mobile-zen':'.ps-moa-workspace.is-mobile');
            const chat = surface.locator('.ps-chat-panel');
            const footer = surface.locator('.ps-mobile-session-status');
            const input = surface.locator('textarea');
            const stop = surface.getByRole('button', { name: 'Stop the current turn', exact: true });
            await expect(input).toBeVisible();
            await expect(footer).toBeVisible();
            if (themeId === 'ms-dos') await expect(surface.locator('.ps-mobile-session-name')).toContainText(sessionId);
            if (mode==='zen') {
                const select=surface.getByRole('button',{name:'Select session'});
                expect(await select.evaluate(el=>{const r=el.getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===el;})).toBe(true);
                expect((await select.boundingBox()).height).toBe(44);
            }
            await page.clock.install();
            async function update(fields) {
                snapshot = fields;
                const before = reads;
                await page.clock.fastForward(4100);
                await expect.poll(() => reads).toBeGreaterThan(before);
                // Give the response merge and layout their next animation frame.
                await page.clock.runFor(32);
            }
            const geometry = () => chat.evaluate(el => {
                const transcript = el.querySelector('.ps-scroll-panel').getBoundingClientRect();
                const header = document.querySelector('.ps-mobile-focus-header').getBoundingClientRect();
                return { transcriptBottom: transcript.bottom, headerTop: header.top, headerHeight: header.height };
            });
            const assertSame = async expected => {
                const actual = await geometry();
                for (const key of Object.keys(expected)) expect(Math.abs(actual[key] - expected[key]), key).toBeLessThan(1);
            };
            // Phones (<= 600 px): while Stop shows, the turn state and the
            // actions take their own row under the input (owner decision A).
            // The composer then grows by exactly that row; the input row and
            // the header do not move.
            const composerRows = () => surface.locator('.ps-prompt-shell').evaluate(shell => {
                const style = getComputedStyle(shell);
                return { rows: style.gridTemplateRows.split(' ').map(parseFloat), gap: parseFloat(style.rowGap) || 0 };
            });
            const assertOneActionRowTaller = async (idleGeometry, idleRows) => {
                const running = await composerRows();
                expect(idleRows.rows).toHaveLength(1);
                expect(running.rows).toHaveLength(2);
                expect(Math.abs(running.rows[0] - idleRows.rows[0]), 'input row').toBeLessThan(1);
                const actual = await geometry();
                expect(Math.abs(idleGeometry.transcriptBottom - actual.transcriptBottom - (running.rows[1] + running.gap)), 'one action row').toBeLessThan(1);
                expect(Math.abs(actual.headerTop - idleGeometry.headerTop), 'headerTop').toBeLessThan(1);
                expect(Math.abs(actual.headerHeight - idleGeometry.headerHeight), 'headerHeight').toBeLessThan(1);
                const shellBox = await surface.locator('.ps-prompt-shell').boundingBox();
                expect((await input.boundingBox()).width / shellBox.width, 'input width share').toBeGreaterThanOrEqual(0.7);
            };
            const idle = await geometry();
            const idleRows = await composerRows();
            await expect(stop).toHaveCount(0);
            await expect(chat.locator('.ps-panel-bottom-sticky')).toHaveCount(0);
            await update({ status: 'running', statusVersion: 5, updatedAt: T0 + 5000 });
            await expect(footer).not.toContainText('Working');
            await expect(chat.locator('.ps-panel-bottom-sticky')).toHaveCount(0);
            await assertSame(idle);
            await update({ status: 'running', statusVersion: 7, updatedAt: T0 + 1000 });
            await expect(footer).toContainText('Working');
            await expect(stop).toBeEnabled();
            await assertOneActionRowTaller(idle, idleRows);
            const running = await geometry();
            await update({ status: 'idle', statusVersion: 8, updatedAt: T0 + 2000 });
            await expect(footer).not.toContainText('Working');
            await expect(stop).toHaveCount(0);
            await expect(chat.locator('.ps-panel-bottom-sticky')).toHaveCount(0);
            await assertSame(idle);
            await update({ status: 'running', statusVersion: 9, updatedAt: T0 + 3000 });
            await expect(footer).toContainText('Working');
            await expect(stop).toBeEnabled();
            await assertSame(running);
            await input.fill('Preserve this queued prompt');
            await surface.getByRole('button', { name: 'Send prompt', exact: true }).click();
            await page.clock.runFor(100);
            await expect.poll(() => sends).toBe(1);
            await expect(chat).toContainText('Preserve this queued prompt');
            await expect(footer).toContainText('1 queued');
            await assertSame(running);
            expect(await chat.getByText(/Preserve this queued prompt/).count()).toBe(1);
            const queued = await geometry();
            await update({ status: 'idle', statusVersion: 8, updatedAt: T0 + 9000 });
            await expect(footer).toContainText('Working');
            await expect(chat).toContainText('Preserve this queued prompt');
            await expect(footer).toContainText('1 queued');
            await expect(footer).toContainText('Working');
            await assertSame(queued);
            await page.screenshot({path:`/tmp/mobile-header-${mode}-${themeId}.png`});
            const box = await surface.locator(mode==='zen'?'.ps-mobile-zen-composer':'.ps-moa-pane-composer').boundingBox();
            expect(Math.abs(box.y-(await geometry()).transcriptBottom)).toBeLessThan(5);
            // Stop remains reachable alongside Send at the narrowest phone and
            // keyboard viewport, and targets the focused session only.
            await page.clock.resume();
            await page.setViewportSize({ width: 320, height: 400 });
            await expect.poll(async () => { const r = await stop.boundingBox(); return r.y + r.height; }).toBeLessThanOrEqual(400);
            const stopBox = await stop.boundingBox();
            const inputBox = await input.boundingBox();
            const sendBox = await surface.locator('.ps-send-button').boundingBox();
            expect(stopBox.width).toBeGreaterThanOrEqual(44);
            expect(stopBox.height).toBeGreaterThanOrEqual(44);
            // The controls have their own row under the input.
            expect(inputBox.y + inputBox.height).toBeLessThanOrEqual(stopBox.y);
            expect(Math.abs((sendBox.y + sendBox.height / 2) - (stopBox.y + stopBox.height / 2))).toBeLessThan(2);
            expect(stopBox.x + stopBox.width).toBeLessThanOrEqual(sendBox.x);
            expect(sendBox.x + sendBox.width).toBeLessThanOrEqual(320);
            expect(stopBox.y + stopBox.height).toBeLessThanOrEqual(400);
            // The turn status is readable and on screen beside the controls.
            const turnState = surface.getByTestId('session-turn-state');
            await expect(turnState).toBeVisible();
            await expect(turnState).toHaveText('running');
            const stateBox = await turnState.boundingBox();
            expect(stateBox.x).toBeGreaterThanOrEqual(0);
            expect(stateBox.x + stateBox.width).toBeLessThanOrEqual(stopBox.x);
            expect(stateBox.y + stateBox.height).toBeLessThanOrEqual(400);
            // Steer sits between Stop and Send with the same 44 x 44 target.
            const steer = surface.getByTestId('turn-steer-button');
            await expect(steer).toHaveAttribute('data-state', 'disabled');
            await input.fill('Steer the focused session');
            await expect(steer).toHaveAttribute('data-state', 'ready');
            const steerBox = await steer.boundingBox();
            expect(steerBox.width).toBeGreaterThanOrEqual(44);
            expect(steerBox.height).toBeGreaterThanOrEqual(44);
            expect(stopBox.x + stopBox.width).toBeLessThanOrEqual(steerBox.x);
            expect(steerBox.x + steerBox.width).toBeLessThanOrEqual((await surface.locator('.ps-send-button').boundingBox()).x);
            expect(steerBox.y + steerBox.height).toBeLessThanOrEqual(400);
            await steer.click();
            await expect.poll(() => steers.length).toBe(1);
            expect(steers[0].path).toBe(`/api/v1/management/sessions/${sessionId}/steer`);
            expect(steers[0].body.options.text).toBe('Steer the focused session');
            await expect(steer).toHaveAttribute('data-state', 'sending');
            await expect(steer).toBeDisabled();
            await expect(stop).toBeEnabled();
            await expect(input).toBeFocused();
            releaseSteer();
            // A refused steer keeps the draft and the focus.
            await expect(surface.getByTestId('control-notice')).toHaveAttribute('data-reason', 'too_many');
            await expect(input).toHaveValue('Steer the focused session');
            await expect(input).toBeFocused();
            await input.fill('Keep my draft while stopping');
            await stop.click();
            await expect.poll(() => stops.length).toBe(1);
            expect(stops[0].path).toBe(`/api/v1/management/sessions/${sessionId}/stop-turn`);
            await expect(stop).toBeDisabled();
            await expect(input).toBeFocused();
            releaseStop();
            await expect(stop).toHaveCount(0);
            await expect(input).toHaveValue('Keep my draft while stopping');
            expect(errors).toEqual([]);
        } finally { await new Promise(resolve => stub.server.close(resolve)); }
    });
}

// Two MoA panels on two running sessions: Steer acts on the focused panel's
// session only, and the other panel shows no control change.
test('MoA: Steer routes to the focused panel only', async ({ page }) => {
    const stub = await startStubServer(0, { sessionCount: 4 });
    const sid = i => `1111111${i}-2222-3333-4444-55555555555${i}`;
    const chat = i => ({ id: `panel-${i}`, type: 'chat', sessionId: sid(i) });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const steers = [];
    try {
        await page.route('**/api/v1/**', async route => {
            const request = route.request(), path = new URL(request.url()).pathname;
            const answer = result => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, result }) });
            if (path.endsWith('/me/profile')) return answer({ isAdmin: false, profileSettings: { themeId: 'terminal-green',
                moa: { version: 2, composerMode: 'shared', tree: { id: 'split', type: 'split', direction: 'row', ratio: 50, first: chat(0), second: chat(2) } } } });
            if (path.endsWith('/management/users/me/features')) return answer({ userId: 1, flags: [{ featureKey: 'sessions.steering', effective: true }] });
            const detail = /\/sessions\/([^/]+)$/.exec(path);
            if (detail && request.method() === 'GET') {
                return answer({ sessionId: detail[1], title: `Session ${detail[1].at(-1)}`, status: 'running', acceptsTurnControl: true,
                    activeTurnIndex: 2, turnHigh: 2, model: 'github-copilot:claude-sonnet-5', createdAt: T0, updatedAt: T0 });
            }
            const steer = /\/management\/sessions\/([^/]+)\/steer$/.exec(path);
            if (steer) { steers.push({ sessionId: steer[1], body: request.postDataJSON() }); return answer({ outcome: 'too_many' }); }
            return route.fallback();
        });
        await page.setViewportSize({ width: 1600, height: 1000 });
        await page.goto(`http://127.0.0.1:${stub.port}/`);
        await page.getByRole('button', { name: 'Master of Agents', exact: true }).click();
        const a = page.locator('[data-moa-panel="panel-0"]'), b = page.locator('[data-moa-panel="panel-2"]');
        await b.locator('header').first().click();
        await expect(b).toHaveClass(/is-focused/);
        const composerB = page.locator(`.ps-prompt-shell[data-session-id="${sid(2)}"]`);
        await composerB.getByTestId('composer-input').fill('only for the second agent');
        await composerB.getByTestId('turn-steer-button').click();
        await expect(composerB.getByTestId('control-notice')).toHaveAttribute('data-reason', 'too_many');
        expect(steers.map(entry => entry.sessionId)).toEqual([sid(2)]);
        await expect(page.locator(`[data-session-id="${sid(0)}"] [data-testid^="control-"]`)).toHaveCount(0);
        await a.locator('header').first().click();
        await expect(a).toHaveClass(/is-focused/);
        const composerA = page.locator(`.ps-prompt-shell[data-session-id="${sid(0)}"]`);
        await expect(composerA.getByTestId('turn-steer-button')).toHaveAttribute('data-state', 'disabled');
        await expect(composerA.getByTestId('control-notice')).toHaveCount(0);
        expect(steers).toHaveLength(1);
        expect(errors).toEqual([]);
    } finally { await new Promise(resolve => stub.server.close(resolve)); }
});

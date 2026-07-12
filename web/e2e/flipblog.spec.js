import { test, expect } from '@playwright/test';

test('home lists seeded flipbooks', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'FlipBlog' })).toBeVisible();
  await expect(page.getByText('A Copa do Mundo FIFA 2026').first()).toBeVisible();
  await expect(page.getByText('O Brasil na Copa do Mundo').first()).toBeVisible();
});

test('reader opens a flippable book', async ({ page }) => {
  await page.goto('/#/read/copa-do-mundo-fifa-2026');
  await expect(page.getByRole('heading', { name: 'A Copa do Mundo FIFA 2026' })).toBeVisible();
  await page.waitForSelector('.flipbook', { timeout: 10000 });
  await page.waitForTimeout(800);
  await expect(page.locator('.fb-page')).toHaveCount(2);
  await expect(page.locator('.page-indicator')).toContainText('/');
});

test('admin can log in and publish a flipbook', async ({ page }) => {
  await page.goto('/#/login');
  await page.fill('input[type="text"]', 'admin');
  await page.fill('input[type="password"]', 'changeme');
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByRole('heading', { name: 'Painel de publicações' })).toBeVisible();

  await page.getByRole('button', { name: '+ Nova publicação' }).click();
  await page.fill('input[required]', 'Meu Flipblog E2E');

  const editor = page.locator('.ql-editor');
  await editor.click();
  await page.keyboard.type('Conteudo da pagina um');
  await page.getByRole('button', { name: '⤓ Quebra de página' }).click();
  await page.keyboard.type('Conteudo da pagina dois');

  const [postResp] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes('/api/posts') && r.request().method() === 'POST',
      { timeout: 10000 }
    ),
    page.getByRole('button', { name: 'Salvar', exact: true }).click(),
  ]);
  const slug = (await postResp.json()).slug;

  // The published flipbook is reachable by slug and renders as a flippable book.
  await page.goto(`/#/read/${slug}`);
  await expect(page.getByRole('heading', { name: 'Meu Flipblog E2E' })).toBeVisible();
  await page.waitForSelector('.flipbook', { timeout: 10000 });
  await expect(page.locator('.fb-page').first()).toBeVisible();
});

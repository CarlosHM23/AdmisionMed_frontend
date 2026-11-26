import { expect, test } from '@playwright/test';

const apiResponse = (body, status = 200) => ({
  status,
  contentType: 'application/json',
  body: JSON.stringify(body),
});

async function mockLogin(page, role = 'operador') {
  const user = {
    id: 17,
    name: 'Ana Salud',
    email: 'ana@example.test',
    telefono: '5550101',
    role,
  };

  await page.route('**/api/login', async (route) => {
    const body = route.request().postDataJSON();
    if (body.email === 'ana@example.test' && body.password === 'ClaveSegura123') {
      await route.fulfill(apiResponse({ access_token: 'e2e-token', expires_in: 3600 }));
      return;
    }

    await route.fulfill(apiResponse({ message: 'Credenciales inválidas' }, 401));
  });

  await page.route('**/api/me', (route) => route.fulfill(apiResponse(user)));
  await page.route('**/api/user/profile', (route) =>
    route.fulfill(apiResponse({
      data: {
        name: user.name,
        email: user.email,
        telefono: user.telefono,
      },
    })),
  );
  await page.route('**/api/dashboard/stats', (route) => route.fulfill(apiResponse({})));
  await page.route('**/api/personal_salud*', (route) => route.fulfill(apiResponse({ data: [] })));

  return user;
}

async function signInFrom(page, path = '/admin') {
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel('Email').fill('ana@example.test');
  await page.getByLabel('Contraseña').fill('ClaveSegura123');
  await page.getByRole('button', { name: 'Entrar al Sistema' }).click();
}

test('allows a valid login and returns to the protected destination', async ({ page }) => {
  await mockLogin(page);

  await signInFrom(page, '/admin');

  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByRole('heading', { name: 'Panel de Administración' })).toBeVisible();
});

test('shows an error and stays signed out after invalid credentials', async ({ page }) => {
  await mockLogin(page);
  await page.goto('/login', { waitUntil: 'domcontentloaded' });
  await page.getByLabel('Email').fill('ana@example.test');
  await page.getByLabel('Contraseña').fill('incorrecta');
  await page.getByRole('button', { name: 'Entrar al Sistema' }).click();

  await expect(page.getByRole('alert')).toContainText('Credenciales inválidas');
  await expect(page).toHaveURL(/\/login$/);
  await expect.poll(() => page.evaluate(() => localStorage.getItem('access_token'))).toBeNull();
});

test('redirects an unauthenticated user back to their protected profile', async ({ page }) => {
  await mockLogin(page);

  await signInFrom(page, '/admin/perfil');

  await expect(page).toHaveURL(/\/admin\/perfil$/);
  await expect(page.getByRole('heading', { name: 'Mi Perfil' })).toBeVisible();
});

test('updates profile details and changes the password', async ({ page }) => {
  await mockLogin(page);

  let updatedProfile;
  await page.route('**/api/user/profile', async (route) => {
    if (route.request().method() === 'PUT') {
      updatedProfile = route.request().postDataJSON();
      await route.fulfill(apiResponse({ data: updatedProfile }));
      return;
    }
    await route.fulfill(apiResponse({
      data: {
        name: 'Ana Salud',
        email: 'ana@example.test',
        telefono: '5550101',
      },
    }));
  });

  let changedPassword;
  await page.route('**/api/user/change-password', async (route) => {
    changedPassword = route.request().postDataJSON();
    await route.fulfill(apiResponse({ message: 'Contraseña actualizada' }));
  });

  await signInFrom(page, '/admin/perfil');
  await expect(page.getByRole('heading', { name: 'Mi Perfil' })).toBeVisible();

  await page.getByRole('button', { name: 'Editar' }).click();
  await page.getByLabel('Nombre', { exact: true }).fill('Ana María');
  await page.getByLabel('Teléfono', { exact: true }).fill('5550199');
  await page.getByRole('button', { name: 'Guardar Cambios' }).click();

  await expect.poll(() => updatedProfile).toEqual({
    name: 'Ana María Salud',
    email: 'ana@example.test',
    telefono: '5550199',
  });
  await expect(page.getByText('¡Perfil Actualizado!')).toBeVisible();

  await page.getByLabel('Nueva Contraseña').fill('NuevaClave123');
  await page.getByLabel('Confirmar Contraseña').fill('NuevaClave123');
  await page.getByRole('button', { name: 'Actualizar Contraseña' }).click();

  await expect.poll(() => changedPassword).toEqual({ new_password: 'NuevaClave123' });
  await expect(page.getByText('¡Contraseña Actualizada!')).toBeVisible();
});

test('CP-ADM-15: hides supervisor-only users and blocks direct access for health staff', async ({ page }) => {
  await mockLogin(page, 'personal_salud');

  let usersApiRequested = false;
  await page.route('**/api/users**', async (route) => {
    usersApiRequested = true;
    await route.fulfill(apiResponse({ data: [], last_page: 1 }));
  });

  await signInFrom(page, '/admin/perfil');
  await expect(page.getByRole('heading', { name: 'Mi Perfil' })).toBeVisible();
  await expect(page.getByText('Usuarios', { exact: true })).toHaveCount(0);

  await page.goto('/admin/users', { waitUntil: 'domcontentloaded' });

  await expect(page).toHaveURL(/\/forbidden$/);
  await expect(page.getByText('No tienes permisos para ver esta página.')).toBeVisible();
  expect(usersApiRequested).toBe(false);
});

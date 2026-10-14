document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = document.getElementById('err');
  err.classList.add('hidden');
  const res = await fetch('/api/login', {
    method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin',
    body: JSON.stringify({ username: document.getElementById('u').value, password: document.getElementById('p').value }),
  });
  if (res.ok) { location.href = '/admin/'; return; }
  const data = await res.json().catch(() => ({}));
  err.textContent = data.error || 'No se pudo ingresar';
  err.classList.remove('hidden');
});

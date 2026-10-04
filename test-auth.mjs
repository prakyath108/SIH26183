const resp = await fetch('http://localhost:8080/api/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'admin@cryptotrace.local', password: 'ChangeMe!2026Admin' })
});
const data = await resp.json();
console.log('Login response:', JSON.stringify(data, null, 2));
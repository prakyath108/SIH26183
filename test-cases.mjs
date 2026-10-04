(async () => {
  // Login
  const loginResp = await fetch('http://localhost:8080/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@cryptotrace.local', password: 'ChangeMe!2026Admin' })
  });
  const loginData = await loginResp.json();
  const token = loginData.accessToken;
  
  // Fetch cases
  const casesResp = await fetch('http://localhost:8080/api/cases', {
    method: 'GET',
    headers: { 
      'Authorization': 'Bearer ' + token
    }
  });
  const casesData = await casesResp.json();
  console.log('Cases:', JSON.stringify(casesData, null, 2));
})();
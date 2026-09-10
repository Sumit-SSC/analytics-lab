export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  return res.status(200).json({
    status: 'ok',
    service: 'analytics-lab-vercel-hub',
    timestamp: new Date().toISOString(),
  });
}

// Server-Sent Events hub. The SPA subscribes once and receives live
// notifications when requests are captured or the funnel state changes.
export class Events {
  constructor() {
    this.clients = new Set();
  }

  subscribe(res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    this.clients.add(res);
    const ping = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { /* ignore */ }
    }, 25000);
    const drop = () => { clearInterval(ping); this.clients.delete(res); };
    res.on('close', drop);
    res.on('error', drop);
  }

  broadcast(type, data) {
    const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of this.clients) {
      try { res.write(payload); } catch { this.clients.delete(res); }
    }
  }

  count() { return this.clients.size; }

  closeAll() {
    for (const res of this.clients) { try { res.end(); } catch { /* ignore */ } }
    this.clients.clear();
  }
}

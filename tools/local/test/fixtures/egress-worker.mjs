export default {
  async fetch(request) {
    const target = new URL(request.url).searchParams.get('to') ?? 'http://example.invalid/';
    const r = await fetch(target);
    return new Response(String(r.status), { status: 200 });
  },
};

// IP real de quem chama — lógica PURA (sem express).
//
// Todo limite de tentativa antes do login (login, cadastro, nova senha,
// visitante) é por IP, então o IP errado desliga a proteção. Atrás do Cloudflare
// o IP de quem chama vem no cabeçalho CF-Connecting-IP. O problema: esse
// cabeçalho só é confiável quando a conexão CHEGOU pelo Cloudflare. Acessando o
// app direto pelo domínio do Railway (*.up.railway.app), qualquer um manda o
// cabeçalho que quiser e ganha um balde de tentativas novo a cada request.
//
// Por isso o cabeçalho só vale quando a conexão vem de uma faixa de IP do
// Cloudflare (https://www.cloudflare.com/ips/). Fora disso, vale o IP da própria
// conexão.
//
// A lista de faixas muda raramente; se o Cloudflare publicar uma nova, dá para
// acrescentar por env (IPS_PROXY_CONFIAVEIS) sem deploy de código.

const net = require('net');

const CLOUDFLARE_IPV4 = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22',
  '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20',
  '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
  '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
];
const CLOUDFLARE_IPV6 = [
  '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32',
  '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32',
];

// Express entrega IPv4 como ::ffff:1.2.3.4 quando o socket é IPv6.
function normalizarIp(raw) {
  const ip = String(raw || '').trim();
  if (ip.startsWith('::ffff:') && ip.includes('.')) return ip.slice(7);
  return ip;
}

function adicionar(lista, entrada) {
  const [endereco, prefixo] = String(entrada).trim().split('/');
  const tipo = net.isIP(endereco);
  if (!tipo) return false;
  const familia = tipo === 6 ? 'ipv6' : 'ipv4';
  if (prefixo === undefined) lista.addAddress(endereco, familia);
  else lista.addSubnet(endereco, Number(prefixo), familia);
  return true;
}

// Faixas do Cloudflare + as extras (texto separado por vírgula: IPs ou CIDRs).
function criarListaConfiavel(extras = '') {
  const lista = new net.BlockList();
  for (const faixa of [...CLOUDFLARE_IPV4, ...CLOUDFLARE_IPV6]) adicionar(lista, faixa);
  for (const e of String(extras || '').split(',').filter((s) => s.trim())) adicionar(lista, e);
  return lista;
}

function ehConfiavel(lista, ip) {
  const tipo = net.isIP(ip);
  if (!tipo) return false;
  return lista.check(ip, tipo === 6 ? 'ipv6' : 'ipv4');
}

// `ipConexao`: o IP de quem se conectou ao app (req.ip). `cfConnectingIp`: o
// cabeçalho. `confiarSempre`: a saída de emergência (env
// CONFIAR_CF_CONNECTING_IP=sempre), para o caso de a infraestrutura na frente do
// app não deixar ver o IP do Cloudflare — ver a rota /api/admin/diagnostico-ip.
function ipReal({ ipConexao, cfConnectingIp, lista, confiarSempre = false }) {
  const conexao = normalizarIp(ipConexao);
  const cf = typeof cfConnectingIp === 'string' ? cfConnectingIp.trim() : '';
  if (cf && (confiarSempre || ehConfiavel(lista, conexao))) return normalizarIp(cf);
  return conexao;
}

module.exports = { criarListaConfiavel, ehConfiavel, ipReal, normalizarIp, CLOUDFLARE_IPV4, CLOUDFLARE_IPV6 };

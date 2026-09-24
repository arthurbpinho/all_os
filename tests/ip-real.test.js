// IP real atrás do Cloudflare (server/ip-real.js): o CF-Connecting-IP só vale
// quando a conexão veio mesmo do Cloudflare. Sem isso, quem acessa pelo domínio
// do Railway forja o cabeçalho e zera os limites de tentativa a cada request.
const { criarListaConfiavel, ipReal, ehConfiavel } = require('../server/ip-real');

describe('IP real atrás do Cloudflare', () => {
  const lista = criarListaConfiavel();

  it('conexão vinda do Cloudflare: vale o cabeçalho', () => {
    expect(ipReal({ ipConexao: '162.158.1.10', cfConnectingIp: '200.1.2.3', lista })).toBe('200.1.2.3');
    expect(ipReal({ ipConexao: '2606:4700::1', cfConnectingIp: '2804:14c::9', lista })).toBe('2804:14c::9');
  });

  it('conexão direta (fora do Cloudflare): o cabeçalho forjado é ignorado', () => {
    expect(ipReal({ ipConexao: '45.10.20.30', cfConnectingIp: '1.1.1.1', lista })).toBe('45.10.20.30');
    expect(ipReal({ ipConexao: '::ffff:45.10.20.30', cfConnectingIp: '1.1.1.1', lista })).toBe('45.10.20.30');
  });

  it('sem cabeçalho vale a conexão, já sem o prefixo ::ffff:', () => {
    expect(ipReal({ ipConexao: '::ffff:162.158.1.10', cfConnectingIp: undefined, lista })).toBe('162.158.1.10');
  });

  it('faixas extras por env e a saída de emergência', () => {
    const comExtra = criarListaConfiavel('10.0.0.0/8, 127.0.0.1');
    expect(ehConfiavel(comExtra, '10.20.30.40')).toBe(true);
    expect(ehConfiavel(comExtra, '127.0.0.1')).toBe(true);
    expect(ehConfiavel(lista, '10.20.30.40')).toBe(false);
    expect(ipReal({ ipConexao: '45.10.20.30', cfConnectingIp: '1.1.1.1', lista, confiarSempre: true })).toBe('1.1.1.1');
  });

  it('entrada lixo não quebra', () => {
    expect(ehConfiavel(lista, 'nao-e-ip')).toBe(false);
    expect(ipReal({ ipConexao: '', cfConnectingIp: 'x', lista })).toBe('');
  });
});

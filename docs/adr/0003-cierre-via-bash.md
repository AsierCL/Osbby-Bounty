# ADR-0003 — Cerrar la vía `bash` del Anexo A

- **Estado**: aceptado (Fase C)
- **Fecha**: 2026-11-11
- **Specs**: S9 (`proxy de salida propio` + `diseño de enforcement a nivel SO` + `Esto cierra la vía bash del Anexo A: documenta la decisión en un ADR`), S18
- **Depende de**: ADR-0001 (paquete aparte, runner propio), ADR-0002 (toolchain)

## El problema, concreto

El Anexo A del plan maestro identificó la fuga principal: si el agente tiene `bash`, entonces
`curl`, `nc` o `python -c requests` se cagan en todo el scope engine. `bounty_scope` decide sobre lo
que el agente *dice* que va a contactar; `curl` decide por su cuenta.

Tres capas lo cierran, y ninguna sola alcanza:

| Capa | Qué cubre | Qué NO cubre |
|---|---|---|
| L1. Runner sin `bash` | Subagentes con allowlist de tools que no incluye `bash` (S19a) | El proceso padre del agente, si conserva `bash` |
| L2. Proxy de salida | Cualquier proceso que respete `HTTP_PROXY`/`HTTPS_PROXY`, incluidas tools que abren sus propios sockets | Un proceso que ignore la variable (`curl --noproxy '*'`, `nc` directo) |
| L3. Regla de firewall del SO | **Todo** el tráfico del usuario dedicado | Nada… si está aplicada |

El proxy es necesario y **no suficiente**. Este ADR lo deja escrito para que nadie confunda "tengo
proxy" con "estoy contenido".

## Decisión

1. **El proxy es el único camino de salida permitido** (`src/core/proxy.ts`): valida host, puerto y
   path contra el mismo matcher de scope que `bounty_run`, aplica el mismo token bucket, y registra
   cada decisión (permitida y denegada) sin guardar headers.
2. **La ejecución de herramientas vive bajo un usuario dedicado** (por ejemplo `bounty`), distinto del
   usuario de escritorio. Ese usuario no tiene credenciales del agente, ni del navegador, ni del
   repositorio.
3. **Regla de firewall: default deny de salida, permitir solo el proxy.** El agente no aplica la
   regla; la aplica el humano una vez, y se verifica con el script de demostración.
4. **Los subagentes no reciben `bash` genérico.** Su allowlist nombra tools concretas (fase D).

## Guía de instalación de la regla (para el humano, no aplicada por el agente)

Variables: `BOUNTY_USER=bounty`, `PROXY_PORT=8888`, `AGENT_PID_USER` = uid del usuario dedicado.

### nftables (recomendado)

```nft
# /etc/nftables.d/bounty-egress.nft
table inet bounty_egress {
  chain output {
    type filter hook output priority 0; policy drop;

    # loopback: el proxy y los laboratorios locales
    oif "lo" accept
    ip daddr 127.0.0.0/8 accept
    ip6 daddr ::1 accept

    # DNS solo al resolver local (necesario para que el proxy pueda resolver)
    ip daddr <RESOLVER_IP> udp dport 53 accept
    ip daddr <RESOLVER_IP> tcp dport 53 accept

    # el único destino externo: el proxy, en localhost
    ip daddr 127.0.0.1 tcp dport 8888 accept

    # nada más sale
    counter reject with icmpx type admin-prohibited
  }
}
```

Aplicación (una vez, con `sudo`, y solo después de leerla):

```bash
sudo nft -f /etc/nftables.d/bounty-egress.nft
sudo nft list table inet bounty_egress     # verificación
```

### iptables (alternativa)

```bash
sudo iptables -A OUTPUT -o lo -j ACCEPT
sudo iptables -A OUTPUT -d 127.0.0.0/8 -j ACCEPT
sudo iptables -A OUTPUT -p udp --dport 53 -d <RESOLVER_IP> -j ACCEPT
sudo iptables -A OUTPUT -p tcp --dport 53 -d <RESOLVER_IP> -j ACCEPT
sudo iptables -A OUTPUT -d 127.0.0.1 -p tcp --dport 8888 -j ACCEPT
sudo iptables -A OUTPUT -j REJECT
```

> Nota honesta: una regla `policy drop` en `output` afecta a **todo** el tráfico de la máquina, no
> solo al usuario `bounty`. Si se quiere acotar por usuario, hace falta el match `owner` (iptables
> `-m owner --uid-owner`) o un namespace de red dedicado para el proceso del agente. Elegir entre
> "máquina entera contenida" y "solo el agente contenido" es una decisión del humano, no del agente.

## Demostración

`scripts/demo-egress.sh` tiene dos partes:

- **Parte A (segura, ejecutable ya):** levanta el proxy en localhost y hace `curl -x` a un destino
  fuera de scope. Resultado esperado: `403 egress denied`, y el proxy registra la denegación sin
  intentar conexión. Esta parte no genera tráfico fuera de localhost.
- **Parte B (requiere la regla aplicada):** intenta el bypass con `curl --noproxy '*'` contra una
  dirección TEST-NET (`192.0.2.1`, reservada, no enrutable). Sin la regla, la conexión se intenta
  (y falla por timeout o por red no enrutable): eso **demuestra que el proxy solo no alcanza**. Con
  la regla, falla en el firewall de inmediato.

El agente **no ejecuta la parte B**: implica intentar salir a un destino no-localhost y S1 lo
prohíbe. Queda como procedimiento verificable por el humano.

## Consecuencias

- El proxy agrega latencia y un punto de falla: si se cae, no hay red para el agente. Es la
  propiedad deseada (fail closed), no un bug.
- El proxy resuelve por nombre y reenvía; no hace MITM ni inspección TLS en `CONNECT`. La decisión
  sobre un túnel es por host:puerto, no por contenido. Aceptado: el objetivo es alcance, no DLP.
- La regla del SO es responsabilidad del humano y no se versiona aplicada en este repo.

## NO VERIFICADO

1. Que la regla `nftables`/`iptables` propuesta funcione tal cual en esta máquina: **no se aplicó**.
2. Que un `curl --noproxy '*'` falle con la regla puesta: no se ejecutó (requiere la regla).
3. Que un proceso hijo de Pi herede `HTTP_PROXY`: depende de cómo se lance; la fase D fija el `env`
   del runner, pero no se probó todavía con un hijo real.

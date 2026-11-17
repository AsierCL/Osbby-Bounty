# Engram del bounty (propio, adentro del repo)

Esta herramienta tiene **su propia memoria**. No usa el Engram del sistema (ese vive en `7437` y es
del agente de desarrollo): acá hay otro contenedor, otro puerto (`7438`) y otra base, dentro de
`engram/data/`.

Todo lo necesario para replicar la herramienta está en este directorio:

```
gentle-bounty/
├── bin/gentle-bounty        lanzador: exporta ENGRAM_URL de ESTE Engram y lo levanta si hace falta
├── engram/
│   ├── docker-compose.yml   runtime local (serve, host network, puerto 7438)
│   ├── bin/engram-bounty    up | down | ensure | status | logs | cli
│   ├── bin/install.sh       instalación en una máquina nueva
│   ├── data/                memorias (gitignored: privadas, no viajan en git)
│   └── README.md            este archivo
└── ...resto de la herramienta
```

## Instalación

```bash
engram/bin/install.sh          # verifica docker, prepara data/, levanta el contenedor
```

Requisitos: `docker` + el plugin `docker compose`. Nada más. La imagen está pinneada
(`ghcr.io/gentleman-programming/engram:3.7.1`) así que no hace falta compilar ni clonar Engram.

## Uso

```bash
engram/bin/engram-bounty up        # levanta y espera /health
engram/bin/engram-bounty status    # /health + proyecto detectado
engram/bin/engram-bounty logs
engram/bin/engram-bounty cli doctor
engram/bin/engram-bounty down      # el dato sigue en engram/data
```

`bin/gentle-bounty <programa>` hace `ensure` automáticamente (levanta sólo si no está sano) y exporta
`ENGRAM_URL=http://127.0.0.1:7438` para la sesión y para sus subagentes. Para apagarlo:
`GENTLE_BOUNTY_ENGRAM=off bin/gentle-bounty ...`. Para otro puerto:
`GENTLE_BOUNTY_ENGRAM_PORT=7440` y `ENGRAM_PORT=7440`.

## Por qué así

- **Aislamiento.** El plugin de Pi elige el servidor por `ENGRAM_URL`. Con la URL explícita no
  auto-arranca el binario del sistema ni compara identidades: la sesión de bounty sólo ve su memoria.
- **Portable.** Mover (o clonar) `gentle-bounty/` se lleva el compose, los scripts, la doc y —si copiás
  `engram/data/`— también lo aprendido. La imagen viene de un tag fijo, así que no depende de rutas
  vecinas.
- **Sin servicio permanente.** `restart: "no"`: se levanta cuando el lanzador lo necesita y se baja
  con `down`.
- **Proyecto correcto.** El repo se monta read-only y el server corre desde ahí, así que
  `/project/current` detecta `gentle-bounty` en lugar de `data`.

## Verificación

```bash
curl -s http://127.0.0.1:7438/health
curl -s http://127.0.0.1:7438/runtime-contract | head -c 120
```

`/health` debe decir `"version":"3.7.1"` (o la del tag) y `/runtime-contract` debe devolver
`"contract_id":"engram.pi-http-runtime/v1"`. El contrato es lo que el plugin exige antes de habilitar
memoria; si falta, la memoria queda bloqueada y lo dice.

## Backup

```bash
engram/bin/engram-bounty down
tar czf bounty-engram-$(date +%F).tgz -C engram data
```

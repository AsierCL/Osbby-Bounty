# Herramientas de recon con `bounty_run`

Las cuatro corren por `bounty_run` como cualquier binario: el gate valida cada host del argv, el ritmo es
el del programa y todo queda en la cadena. `recon_tool` agrega la estructura: el arnés parsea la salida
JSON/NDJSON y anota `recon-intelligence` con los hosts/endpoints, además de la salida cruda.

```
bounty_run tool="subfinder" args=["-d","acme.com","-silent","-o","/tmp/subs.txt"] target="acme.com" recon_tool="subfinder"
bounty_run tool="httpx"     args=["-l","/tmp/subs.txt","-json","-o","/tmp/live.json"] target="acme.com" recon_tool="httpx"
bounty_run tool="katana"    args=["-u","https://acme.com","-json","-o","/tmp/endpoints.json"] target="https://acme.com" recon_tool="katana"
```

- `subfinder`: pasivo, no toca el target; sus hosts **sí** se validan contra el scope antes de usarlos.
- `httpx`: valida vivos y tecnologías; `-json` es lo que se parsea.
- `katana`: rastrea; respetá `-d` (profundidad) y el ritmo.
- `gobuster`/`nuclei`: son clases destructivas cuando hacen fuerza bruta/plantillas intrusivas; el gate
  pausa y el humano decide. No los uses para "ver si aparece algo": tasa de falsos positivos alta y
  mucho ruido en la cadena.

Si alguno no está instalado, el preflight lo dice y no se instala nada por su cuenta: se corre con lo que
haya.

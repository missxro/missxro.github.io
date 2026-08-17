---
author: Rocío del Pilar Felipe
pubDatetime: 2026-08-17T19:40:00Z
title: "Escaneo de vulnerabilidades con Trivy via Ansible"
slug: escaneo-de-vulnerabilidades-con-trivy
featured: true
draft: false
tags:
  - trivy
  - ansible
  - vulnerabilidades
description: Cómo inventariar vulnerabilidades de varias VMs Linux con Trivy y Ansible, sin instalar agentes, sin dejar rastro en los hosts y sin alto impacto sobre producción.

---

## Table of Contents

## Objetivo

Inventariar las vulnerabilidades de **varias VMs Linux** cumpliendo estas dos condiciones:

- **Agentless**: No queremos instalar nada permanente en los hosts.
- **Carga de trabajo mínima**: El escaneo debe suponer poca carga para el hardware de los servidores. Esto es especialmente útil en el caso de que estemos hablando de **servidores en producción**.

## Antes de empezar; ¿qué es Trivy?

Es un **escáner de vulnerabilidades** que compara los paquetes instalados de un sistema contra una base de datos de CVEs. Puede analizar **imágenes de contenedor, repositorios de código, filesystems, configuraciones de IaC y secretos**.

### Workflow

El flujo de trabajo simplificado que seguirá la utilidad en cada nodo es el siguiente:
```
Ansible
├── copia el binario Trivy y base de datos de vulns
├── ejecuta el análisis
├── recupera el JSON
└── elimina el rastro
```

![Workflow ilustrado. Ansible copia el binario Trivy y BD de vulns -> Ejecuta el análisis -> Recupera el JSON -> Elimina el rastro](/images/escaneo-de-vulnerabilidades-con-trivy/workflow.webp)


Trivy tiene **varios targets**. La diferencia no está en lo que leen, sino en **qué asume Trivy que es aquello que le pasamos**:

- `image`: Una **imagen de contenedor**. No recibe una ruta, sino una referencia (`nginx:1.25`) o un tar exportado. Trivy la descarga y analiza sus capas.
- `fs`: Un directorio, tratado como **proyecto de código**. Busca manifiestos de dependencias (`package-lock.json`, `go.sum`, etc.).
- `rootfs`: Un directorio, tratado como la **raíz de un sistema operativo**. Detecta la distribución y lee su base de datos de paquetes (`dpkg`, `rpm`, `apk`).

En este caso utilizaremos el perfil `rootfs`, ya que queremos **auditar el sistema operativo**. Ejemplo de uso:

```bash
trivy rootfs \
  --pkg-types os \
  --scanners vuln \
  --parallel 1 \
  --format json \
  --output /tmp/trivy-report.json \
  /
```

La directiva `--pkg-types os` limita el escaneo a gestores de paquetes como `dpkg`, `rpm`, `apk` para hacerlo más ligero.

## Paso 1: Crear la estructura de directorios

Lo primero será crear la estructura de trabajo del servicio **dentro del *control node* de Ansible**.

```bash
mkdir -p ~/trivy-scan/{files,cache,reports}
nano ~/trivy-scan/inventory.ini
```

La estructura que buscamos es esta:

![Foto de la estructura de archivos](/images/escaneo-de-vulnerabilidades-con-trivy/structure.webp)


## Paso 2: Descargar e instalar Trivy

Instalamos la utilidad <a href="https://github.com/aquasecurity/trivy" target="_blank">desde su GitHub oficial</a>. Estoy utilizando la variable de entorno `TRIVY_VERSION` para clarificar, en este caso con la versión `0.72.0`.

```bash
cd ~/trivy-scan
export TRIVY_VERSION=0.72.0
curl -fLO "https://github.com/aquasecurity/trivy/releases/download/v${TRIVY_VERSION}/trivy_${TRIVY_VERSION}_Linux-64bit.tar.gz"
```

Como buena práctica, también descargamos el checksum y verificamos que el archivo que nos hemos descargado tiene el mismo hash:
```bash
curl -fLO "https://github.com/aquasecurity/trivy/releases/download/v${TRIVY_VERSION}/trivy_${TRIVY_VERSION}_checksums.txt"
```

Verificamos...
```bash
sha256sum --ignore-missing -c "trivy_${TRIVY_VERSION}_checksums.txt"
# Resultado esperado: trivy_${TRIVY_VERSION}_Linux-64bit.tar.gz: OK
```

Extraemos el binario de la herramienta:

```bash
tar -xzf "trivy_${TRIVY_VERSION}_Linux-64bit.tar.gz" -C files trivy
# Ajustamos los permisos del binario -> rwx r-x r-x
chmod 0755 files/trivy
```

## Paso 3: Descargar la BD de vulnerabilidades

```bash
./files/trivy image --cache-dir ./cache --download-db-only
```

![Imagen ilustrativa del output al descargar la database de CVEs](/images/escaneo-de-vulnerabilidades-con-trivy/trivy-database.webp)

Deberíamos tener los archivos:
- `metadata.json`: Contiene fechas referentes a la base de datos.
- `trivy.db`: Base de datos con la info que Trivy utiliza para comparar los paquetes instalados con vulns conocidas.

Estos dos archivos serán copiados a los servidores destino y posteriormente eliminados. Por ello, debemos **asegurarnos de que tengan espacio suficiente** en disco.* Si esto es un problema en tu entorno, en **la sección <a href="#alternativa-modo-clienteservidor" >Alternativa: modo cliente/servidor**</a> te presento otra manera de hacerlo.
![Database descargada y su peso](/images/escaneo-de-vulnerabilidades-con-trivy/trivy-cache.webp)

## Paso 4: Crear el playbook

El escaneo de vulnerabilidades está simplificado y orientado a minimizar el impacto en producción sobre los targets;

- No utiliza `sudo`.
- Escanea una VM a la vez.
- Solo revisa paquetes del SO, sin recorrer el filesystem en busca de dependencias.
- Utiliza un único worker.
- No descarga ni consulta nada por Internet (`--skip-db-update`, `--offline-scan`, `--skip-version-check`, `--disable-telemetry`).
- Ejecuta Trivy con prioridad baja (`nice -n 19`).
- Aborta si algo se atasca (`timeout 12m` externo, `--timeout 10m` interno).
- Borra todo lo copiado al terminar, incluso si el escaneo falla.

```yaml file="trivy-scan.yml"
---
- name: OS vulnerability scan with Trivy
  hosts: linux_servers
  gather_facts: false
  serial: 1

  vars:
    local_trivy_binary: "{{ playbook_dir }}/files/trivy"
    local_trivy_cache: "{{ playbook_dir }}/cache"
    local_reports_dir: "{{ playbook_dir }}/reports"

  tasks:
    - name: Create local reports directory
      ansible.builtin.file:
        path: "{{ local_reports_dir }}"
        state: directory
        mode: "0700"
      delegate_to: localhost
      run_once: true
      become: false

    - name: Run temporary Trivy scan
      block:
        - name: Create temporary directory on the target
          ansible.builtin.tempfile:
            state: directory
            suffix: trivy-scan
            path: /var/tmp
          register: trivy_temp_directory

        - name: Copy Trivy binary to the target
          ansible.builtin.copy:
            src: "{{ local_trivy_binary }}"
            dest: "{{ trivy_temp_directory.path }}/trivy"
            mode: "0700"

        - name: Copy Trivy vulnerability database to the target
          ansible.builtin.copy:
            src: "{{ local_trivy_cache }}/"
            dest: "{{ trivy_temp_directory.path }}/cache/"
            mode: preserve

        - name: Scan operating system packages
          ansible.builtin.command:
            argv:
              - timeout
              - 12m
              - nice
              - -n
              - "19"
              - "{{ trivy_temp_directory.path }}/trivy"
              - rootfs
              - --cache-dir
              - "{{ trivy_temp_directory.path }}/cache"
              - --scanners
              - vuln
              - --pkg-types
              - os
              - --parallel
              - "1"
              - --skip-db-update
              - --offline-scan
              - --skip-version-check
              - --disable-telemetry
              - --no-progress
              - --timeout
              - 10m
              - --format
              - json
              - --output
              - "{{ trivy_temp_directory.path }}/{{ inventory_hostname }}.json"
              - /
          register: trivy_scan_result
          changed_when: false
          failed_when: trivy_scan_result.rc != 0

        - name: Fetch Trivy report
          ansible.builtin.fetch:
            src: "{{ trivy_temp_directory.path }}/{{ inventory_hostname }}.json"
            dest: "{{ local_reports_dir }}/{{ inventory_hostname }}.json"
            flat: true
            validate_checksum: true

      always:
        - name: Remove temporary Trivy files from the target
          ansible.builtin.file:
            path: "{{ trivy_temp_directory.path }}"
            state: absent
          when:
            - trivy_temp_directory is defined
            - trivy_temp_directory.path is defined
```

## Paso 5: Ejecución del playbook

Para asegurarnos de que funciona correctamente, primero probamos con un host:
```bash
ansible-playbook -i inventory.ini trivy-scan.yml --limit <test_host>
```

Verifica que se hayan eliminado los directorios temporales:

```bash
ansible <test_host> -i inventory.ini -m shell -a 'find /var/tmp -maxdepth 1 -type d -name "*trivy-scan*" -print'
```
*\*El directorio temporal se puede modificar en el apartado "Create temporary directory on the target" dentro del playbook*

Y comprueba que Trivy no se ha instalado globalmente:

```bash
ansible <test_host> -i inventory.ini -m shell -a 'command -v trivy || true'
```

Una vez hecho esto, ya podemos ejecutarlo en todos los hosts ;)

```bash
ansible-playbook -i inventory.ini trivy-scan.yml
```

![Playbook ejecutado con éxito](/images/escaneo-de-vulnerabilidades-con-trivy/trivy-playbook-run.webp)

## Alternativa: Modo cliente/servidor

En este *runbook* copiamos el binario y BD en cada host para simplificar el proceso de auditoría. Si hablamos de muchos *targets*, esto puede resultar un problema.

Para ello, está el modo **cliente/servidor de Trivy**, en el cual la BD se queda en el control node y el cliente analiza el file system, extrae el inventario de paquetes instalados y lo envía al servidor, que es el que finalmente compara los datos obtenidos. **Solo se copiaría el binario**.

Es el mismo binario utilizando la directiva `server`, sin embargo, necesitas cumplir una serie de requisitos:
- **Conectividad**: Hasta ahora sólo hacía falta control `node -> host` por SSH gracias a Ansible. Ahora también `host -> control node` por TCP al puerto del servidor.
- **Autenticación**: El servidor escucha en la red mientras dura el escaneo (directiva `--token` necesaria).
- **Proceso independiente**: Hay que arrancar y parar el servidor aparte; si el proceso muere o el playbook se interrumpe a medias, se queda escuchando en el control node.
- **Sigue haciendo falta `--cache-dir`**: El cliente escribe una caché local en el host analizado y por defecto la deja en `~/.cache/trivy`. Debe seguir apuntando al directorio temporal para que la limpieza se la lleve.

## Recursos de interés
- <a href="https://trivy.dev/docs/latest/guide/target/rootfs" target="_blank">Documentación oficial de Trivy en modo Rootfs</a>
- <a href="https://trivy.dev/docs/latest/guide/scanner/vulnerability/#enabling-a-subset-of-package-types" target="_blank">Documentación oficial de Trivy sobre --pkg-types</a>
- <a href="https://trivy.dev/docs/latest/references/modes/client-server/" target="_blank">Documentación oficial de Trivy sobre el modo cliente/servidor</a>
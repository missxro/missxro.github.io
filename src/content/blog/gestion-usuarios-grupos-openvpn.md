---
author: Rocío del Pilar Felipe
pubDatetime: 2026-06-04T17:18:00Z
title: Gestión de usuarios y grupos en OpenVPN Community
slug: gestion-usuarios-grupos-openvpn
featured: true
draft: false
tags:
  - openvpn
  - vpn
description: Cómo publicar rutas para usuarios y grupos mediante el CN del certificado cliente en OpenVPN
---

## Table of Contents

## Introducción

OpenVPN Community no tiene soporte integrado para la **gestión de permisos de usuarios y grupos** de manera nativa. A veces, nos interesa que cierto grupo de usuarios, como puede ser el equipo de soporte, acceda a unas rutas concretas y el equipo de administración a otras.

Para solucionar esta limitación, podemos implementar una **capa local** que consiste en **enviar rutas distintas** dependiendo del usuario que se conecta mediante el ***Common Name* / CN** de su certificado cliente.

## Uso del directorio CCD, ¿en qué consiste?

Usualmente, en el archivo `server.conf` publicamos la ruta de una red o dispositivo de manera global:
```bash
push "route 10.2.0.0 255.255.255.0" # Red entera
push "route 10.2.0.10 255.255.255.255" # Host concreto
```
Eso significa que todos los clientes de la VPN llegarán a esa red mediante el túnel creado. Sin embargo, podemos enviarle a cada usuario solo la ruta del servidor al que queremos que llegue. Aquí vemos un escenario ilustrativo:
![Esquema con servidores y usuarios con permisos diferentes](/images/gestion-usuarios-grupos-openvpn/openvpn-introduccion.png)

Esa configuración sería posible **con el uso del directorio CCD**, que quiere decir *Client Configuration Directory* o **Directorio de Configuraciones por Cliente**. OpenVPN identificará cada usuario mediante el CN o *Common Name* de su certificado expedido por la CA del servidor VPN.

Sin embargo, esto **no es suficiente a nivel de seguridad**. Debemos asegurarnos de que el usuario no pueda alcanzar los nodos no publicados bajo ninguna circunstancia. Para ello, podemos **complementar esta configuración con reglas en el firewall del servidor VPN**.

Cada usuario deberá tener siempre la misma IP dentro del túnel VPN para facilitar la configuración de dichas reglas. Esto también se configura dentro del fichero CCD del usuario haciendo uso de la directiva `ifconfig-push`.

Ejemplo para **soporte1**:
```bash file="/etc/openvpn/server/ccd/soporte1"
ifconfig-push 10.206.0.10 255.255.255.0
push "route 10.20.0.10 255.255.255.255"
```
Ejemplo para **admin1**:
```bash file="/etc/openvpn/server/ccd/soporte1"
ifconfig-push 10.206.0.11 255.255.255.0
push "route 10.20.0.10 255.255.255.255"
push "route 10.20.0.20 255.255.255.255"
push "route 10.20.0.30 255.255.255.255"
```

## Activar CCD en OpenVPN

Para que OpenVPN lea configuraciones específicas por cliente, debemos añadir la directiva `client-config-dir` en nuestro archivo de configuración, en mi caso ubicado en `/etc/openvpn/server/`:

```bash file="server.conf"
...
# --- Red del túnel VPN ---
server 10.206.0.0 255.255.255.0
topology subnet
# --- Localización CCDs ---
client-config-dir /etc/openvpn/server/ccd
ccd-exclusive
...
```

Con esta directiva, cuando un cliente se conecte con el CN "soporte1" en su certificado, OpenVPN buscará `/etc/openvpn/server/ccd/soporte1`.

Creamos el directorio:
```bash
sudo mkdir -p /etc/openvpn/server/ccd
sudo chown root:root /etc/server/openvpn/ccd
sudo chmod 755 /etc/openvpn/server/ccd
```

Con esto ya tenemos habilitada la **gestión de configuraciones por cliente** mediante CCD en OpenVPN Community. Partiendo de esta base, **podría automatizarse el proceso de creación de los CCDs** mediante un *script* o *pipeline*, para hacer escalable y mantenible esta configuración.
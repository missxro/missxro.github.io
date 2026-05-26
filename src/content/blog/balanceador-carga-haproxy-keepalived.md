---
author: Rocío del Pilar Felipe
pubDatetime: 2026-05-26T11:00:00Z
title: Balanceadores de carga con HAProxy y Keepalived
slug: balanceador-carga-haproxy-keepalived
featured: true
draft: false
tags:
  - haproxy
  - keepalived
  - nlb
description:
  Cómo montar un reverse proxy L7 enfocado en la alta disponibilidad usando HAProxy y Keepalived.
---

## Table of Contents

## Conceptos previos

- **HAProxy**: Balanceador de carga y *reverse proxy* de capa 4 / L4 (TCP) y capa 7 / L7 (HTTP/S) que distribuye el tráfico entre varios servidores *backend*.
- **Keepalived**: Servicio que implementa **VRRP (*Virtual Router Redundancy Protocol*)** para proporcionar alta disponibilidad entre varios nodos. Gestiona una **VIP (*Virtual IP*)** en los balanceadores de carga.
    
    El **MASTER posee la VIP** mientras que el BACKUP se queda de respaldo. La VIP **se asigna dinámicamente** a la interfaz de red del LB activo, por lo que en el caso de que el MASTER caiga, pasa al BACKUP.



## ¿Qué problema resuelve Keepalived?

Cuando utilizamos un HAProxy delante de nuestros servidores web, el tráfico lo atraviesa siempre. Si ese nodo cae, perderemos el acceso a nuestros servidores, sin importar cuántos tengamos.

La solución es tener dos nodos con **HAProxy y Keepalived**, de forma que si uno de ellos dos cae, podremos utilizar el otro. En principio, solo el MASTER estará recibiendo las peticiones al tener la VIP, pero si este falla, Keepalived moverá la VIP al BACKUP, ayudándonos a mantener la disponibilidad del servicio.

En este post trabajaremos sobre L7, ya que se utilizará HAProxy en `mode  http`, que nos permite inspeccionar cabeceras HTTP, hacer *redirects*, *health checks*...

## Topología

![Topología de red del ejemplo](/images/balanceador-carga-haproxy-keepalived/net-topology-2.png)

En el DNS, el registro `www` apunta a la VIP `192.168.34.30`. Los clientes nunca
necesitan saber qué nodo LB está activo.

## Prerequisitos: IP de escucha del servidor web

Como buena práctica, debemos asegurarnos de que los servidores web escuchan **solo en su IP real**, no en todas las interfaces.

En cada servidor web (`web01`, `web02`, `web03` - adaptando la IP, claro):

```bash
# /etc/apache2/ports.conf
Listen 192.168.34.11:80   # En escucha por la IP usada por HAProxy

<IfModule ssl_module>
    Listen 192.168.34.11:443
</IfModule>

<IfModule mod_gnutls.c>
    Listen 192.168.34.11:443
</IfModule>
```
Aplicamos cambios y verificamos IP/puerto de escucha:
```bash
systemctl restart apache2
ss -nltp
```

---

## Paso 1: Instalación y configuración de Keepalived

```bash
sudo apt update && sudo apt install keepalived -y
```

### Configuración del MASTER

Dentro de `/etc/keepalived`, creamos el archivo de configuración:

```bash file="keepalived.conf"
# Script de health check para HAProxy
vrrp_script chk_haproxy {
    script "killall -0 haproxy"
    interval 2      # Comprueba cada 2 segundos
    weight -20       # Resta 20 a la prioridad actual en caso de fallo
}

# Configuración de la VIP
vrrp_instance VI_1 {
    state MASTER
    interface enp0s3
    virtual_router_id 51
    priority 110
    advert_int 1
    authentication {
        auth_type PASS
        auth_pass 1111
    }
    virtual_ipaddress {
        192.168.34.30/24
    }
    track_script {
        chk_haproxy
    }

    # Acepta el tráfico de paquetes con destino VIP (192.168.34.30 en este caso)
    accept
}
```


### Por qué necesitamos `vrrp_script`

Sin un ***health check* del servicio HAProxy**, en el caso de que este caiga, **Keepalived no lo detectará** y la VIP seguirá apuntando a un nodo caído. Esta casuística se controla bajándole prioridad al nodo actual, forzando así el uso del BACKUP.

Es importante tener en cuenta que la prioridad restada tendrá que ser proporcional a la usada por nuestro MASTER y BACKUP. Por ejemplo, en el caso de tener `MASTER 110` y `BACKUP 100`, si el MASTER falla y hacemos `weight -2`, seguirá siendo el nodo utilizado por la VIP al tener mayor prioridad; `MASTER 108` y `BACKUP 100`.

### Configuración del BACKUP

Misma configuración que en el MASTER pero cambiando `state` y `priority`:

```bash file="/etc/keepalived/keepalived.conf"
vrrp_script chk_haproxy {
    script "killall -0 haproxy"
    interval 2
    weight -20
}

vrrp_instance VI_1 {
    state BACKUP
    interface enp0s3
    virtual_router_id 51
    priority 100
    advert_int 1
    authentication {
        auth_type PASS
        auth_pass 1111
    }
    virtual_ipaddress {
        192.168.34.30/24
    }
    track_script {
        chk_haproxy
    }
    accept
}
```

El `virtual_router_id` (en este caso `51`) debe ser el mismo en ambos nodos. Si tenemos varios grupos Keepalived en la misma red, cada uno necesitará un ID diferente.


Habilitamos el servicio al inicio del sistema y reiniciamos para aplicar cambios:
```bash
systemctl enable keepalived
systemctl restart keepalived

# Verificar que el MASTER tiene la VIP asignada
ip a
ip -br a
```

## Paso 2: Instalación y configuración de HAProxy

> Realizar la MISMA configuración tanto en MASTER como en BACKUP. La diferencia entre los dos nodos la gestiona Keepalived.

```bash
sudo apt update && sudo apt install haproxy -y
```

### Habilitar ip_nonlocal_bind

HAProxy en el BACKUP intentará hacer `bind` (vincular socket -> IP:puerto) sobre la VIP `192.168.34.30` aunque no la tenga asignada en ese momento. Sin este parámetro, el bind falla y HAProxy no arranca en el nodo BACKUP.

```bash
echo "net.ipv4.ip_nonlocal_bind=1" > /etc/sysctl.d/99-nonlocal-bind.conf
sysctl --system
```

### Configuración con HTTPS con redirect HTTP -> HTTPS en el proxy

HAProxy necesita un `.pem` con certificado + clave (+ *chain* / cadena de la CA si la hay):

```bash
# En el caso de tener chain CA
cat www.ejemplo.com.crt CHAIN-CA.crt www.ejemplo.com.key > /etc/ssl/private/www.ejemplo.com.pem

# En el caso de tener solo una CA
cat www.ejemplo.com.crt CA.crt www.ejemplo.com.key > /etc/ssl/private/www.ejemplo.com.pem

chmod 600 /etc/ssl/private/www.ejemplo.com.pem
```
Archivos utilizados:
- `www.ejemplo.com.crt`: Certificado público del servidor web.
- `CHAIN-CA.crt`: Cadena de certificados. Sirve para **demostrar confianza completa** desde un servidor/cliente hasta la root CA cuando los clientes/servidores no tienen las CAs intermedias registradas como confiables.

    Este fichero **concatena los certificados intermedios** necesarios para llegar a la raíz.
- `www.ejemplo.com.key`: Clave privada del servidor web.

```bash file="/etc/haproxy/haproxy.cfg"
frontend fe_http
    bind 192.168.34.30:80
    mode http
    http-request redirect scheme https code 301

frontend fe_https
    bind 192.168.34.30:443 ssl crt /etc/ssl/private/www.ejemplo.com.pem
    mode http
    option forwardfor       # Añade X-Forwarded-For con la IP real del cliente
    default_backend be_web

backend be_web
    mode http
    balance roundrobin
    option httpchk GET /
    http-check expect status 200
    server web01 192.168.34.11:80 check
    server web02 192.168.34.12:80 check
    server web03 192.168.34.13:80 check
```

La directiva `option forwardfor` es importante para que los servidores web vean la IP real del cliente en lugar de la del balanceador. Sin esto, el cliente se esconde tras la VIP y todas las peticiones tienen `192.168.34.30`.

Esto se debe a que añade la cabecera HTTP `X-Forwarded-For` con la IP real del cliente :p.

### Configuración solo HTTP

```nginx
# /etc/haproxy/haproxy.cfg

frontend fe_http
    bind 192.168.34.30:80
    mode http
    option forwardfor
    default_backend be_web

backend be_web
    mode http
    balance roundrobin
    option httpchk GET /
    http-check expect status 200
    server web01 192.168.34.11:80 check
    server web02 192.168.34.12:80 check
    server web03 192.168.34.13:80 check
```

### Validar y arrancar

```bash
haproxy -c -f /etc/haproxy/haproxy.cfg   # Valida la config antes de arrancar
systemctl enable --now haproxy
systemctl status haproxy
```

## Paso 3: Verificación del funcionamiento

Comprobamos que los servidores web responden directamente:

```bash
curl -I http://192.168.34.11   # 200 OK
curl -I http://192.168.34.12   # 200 OK
curl -I http://192.168.34.13   # 200 OK
```

Comprobamos que la VIP redirige a HTTPS:

```bash
curl -I http://192.168.34.30  # 301 Moved Permanently
```

Simulamos caída del MASTER:

```bash
# En LB1 (MASTER)
systemctl stop keepalived

# En LB2 (BACKUP), verificamos que ha asumido la VIP
ip -br a
# La VIP 192.168.34.30 aparece asignada en enp0s3
```

Para simular la caída específica de HAProxy (que es para lo que sirve el `vrrp_script`):

```bash
# En LB1 (MASTER)
systemctl stop haproxy

# Keepalived detecta la caída, reduce su prioridad y el BACKUP asume la VIP
# En LB2 (BACKUP)
ip -br a
```

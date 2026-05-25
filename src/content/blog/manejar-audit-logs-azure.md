---
author: Rocío del Pilar Felipe
pubDatetime: 2026-05-25T06:33:00Z
title: Cómo enviar logs de Audit a Azure Log Workspace
slug: manejar-audit-logs-azure
featured: true
draft: false
tags:
  - azure
  - logs
  - audit
description:
  En este blog exploraremos la capacidad de analizar los logs generados por el demonio auditd de una VM dentro de Azure en "Áreas de trabajo de Log Analytics / Log Analytics Workspace", de manera que podamos crear alertas y monitorizar de manera activa lo que ocurre en nuestra máquina.
---

## Table of Contents

## Introducción
En este blog exploraremos la capacidad de **analizar los logs generados por el demonio auditd** de una VM dentro de Azure en "Áreas de trabajo de Log Analytics / *Log Analytics Workspace*", de manera que se puedan **crear alertas y monitorizar** de manera activa lo que ocurre en nuestra máquina.

![Flujo de logs](/images/manejar-audit-logs-azure/flujo-de-logs.png)

Como vemos en la imagen, el demonio **auditd** será el encargado de enviar los eventos hacia **syslog** dentro de una *facility* concreta que recogerá ***Azure Monitor Agent* (AMA)**. Este agente recogerá y enviará los eventos hacia nuestro *Log Analytics Workspace* gracias al ***Data Collection Rule* (DCR)** que se encargará de definir qué logs son procesados.

## Requisitos previos

- Tener instaladas las utilidades `auditd` y `audispd-plugins`.
- Disponer de un *Log Analytics Workspace*, *Data Collection Rule* y *Virtual Machine* en Azure.

## Paso 1: Configuración de audit
Será necesario aplicar las reglas que veamos pertinentes dentro de la configuración del demonio **auditd**, ubicada en `/etc/audit/rules.d/`. 

Ejemplo de fichero:
```bash
# Limpiar reglas previas
-D

# Buffer de eventos (aumentar si hay pérdida de eventos bajo carga)
-b 8192

# Inicio de sesión
-w /var/log/lastlog -p wa -k inicio_sesion
-w /var/run/faillock/ -p wa -k intento_fallido

# Archivos críticos del sistema
-w /etc/passwd -p wa -k config_usuarios
-w /etc/shadow -p rwa -k config_usuarios
-w /etc/group -p wa -k config_grupos
-w /etc/gshadow -p rwa -k config_grupos
-w /etc/sudoers -p wa -k sudoers
-w /etc/sudoers.d/ -p wa -k sudoers
-w /etc/pam.d/ -p wa -k config_pam

# Cron y tareas automatizadas
-w /etc/cron.allow -p wa -F auid!=4294967295 -k cron_allow
-w /etc/cron.deny -p wa -F auid!=4294967295 -k cron_deny
-w /etc/crontab -p wa -F auid!=4294967295 -k crontab
-w /etc/cron.hourly/ -p wa -F auid!=4294967295 -k cron_hourly
-w /etc/cron.daily/ -p wa -F auid!=4294967295 -k cron_daily
-w /etc/cron.weekly/ -p wa -F auid!=4294967295 -k cron_weekly
-w /etc/cron.monthly/ -p wa -F auid!=4294967295 -k cron_monthly
-w /etc/anacrontab -p wa -F auid!=4294967295 -k anacron

# Ejecución de comandos como root de usuarios reales
-a always,exit -F arch=b64 -S execve -F euid=0 -F auid>=1000 -F auid!=4294967295 -k root_cmds
-a always,exit -F arch=b32 -S execve -F euid=0 -F auid>=1000 -F auid!=4294967295 -k root_cmds

# Dispositivos externos
-w /media/ -p wa -k dispositivos_extraibles
-w /run/media/ -p wa -k dispositivos_extraibles

# Cambios de permisos
-a always,exit -F arch=b64 -S chmod,chown,fchmod,fchown -F auid!=4294967295 -k cambios_permisos
-a always,exit -F arch=b32 -S chmod,chown,fchmod,fchown -F auid!=4294967295 -k cambios_permisos

# Configuración de red
-w /etc/hosts -p wa -k red_config
-w /etc/resolv.conf -p wa -k red_config
-w /etc/network/ -p wa -k red_config
-w /etc/NetworkManager/ -p wa -k red_config
-w /etc/ssh/sshd_config -p wa -k ssh_config

# Ejecución de binarios del sistema
-w /usr/bin/ -p x -k exec_sistema
-w /usr/sbin/ -p x -k exec_sistema

# Carga y descarga de módulos del kernel
-w /sbin/insmod -p x -k modulos_kernel
-w /sbin/rmmod -p x -k modulos_kernel
-w /sbin/modprobe -p x -k modulos_kernel

# Requerir reinicio para modificar las reglas
-e 2
```

Se puede ver que hago uso de `auid!=4294967295` varias veces. Este `AUID` (user ID, effective user ID y audit user ID) indica que el evento no está asociado a un usuario autenticado real, normalmente porque viene de procesos o servicios del sistema en segundo plano.
 
Para no sobrecargar los logs con esos procesos automáticos, no los mostramos.

## Paso 2: Configuración de audisp
Una vez que auditd ya está registrando los eventos, tendremos que activar el *dispatcher* o emisor de logs de Audit llamado **audisp**. Este *plugin* nos permitirá reenviar los eventos recogidos por audit hacia **syslog**.
Para ello, lo configuramos dentro de `/etc/audit/plugins.d/syslog.conf`:
```bash
active = yes
direction = out
path =  /sbin/audisp-syslog
type = always
args = LOG_INFO LOG_LOCAL6
format = string
```

A continuación, desgloso cada una de las directivas:
- `active = yes`: Activa el plugin.
- `direction = out`: Audisp envía logs hacia fuera, en este caso hacia syslog.
- `path =  /sbin/audisp-syslog`:Ruta al binario del plugin.
- `type = always`: Modo de ejecución del plugin.
- `args = LOG_INFO LOG_LOCAL6`: Nivel de prioridad y facility local6 (destinado para uso personalizado, puedes utilizar otra).
- `format = string`: Formato en texto plano.

## Paso 3: Filtrar syslog
Opcionalmente, podemos filtrar eventos que no queremos que aparezcan en nuestro rsyslog dentro de `/etc/rsyslog.d`.
Es importante que los filtros se apliquen antes de la configuración del AMA, en mi caso antes de `10-azuremonitoragent-omfwd.conf`. El nombre de un posible archivo de configuración podría ser `01-filter-audit.conf`.

Ejemplo:
```bash
# End of Event, indica el final de un evento auditd. No nos proporciona info útil
if $msg contains "type=EOE" then stop
# Current Working Directory, indica el directorio donde se ejecuta algo. Genera mucho ruido
if $msg contains "type=CWD" then stop
# PATH describe ficheros involucrados. (null) quiere decir sin ruta real, se trata de un evento incompleto / irrelevante
if $msg contains "type=PATH" and $msg contains "name=(null)" then stop
# Eventos de gestión de credenciales del kernel- Genera mucho ruido
if $msg contains "type=CRED_" then stop

# --- Ruido generado por AAD SSH Login / Certificados SSH de Azure

if (
    $programname == "aad_certhandler"
    and $syslogfacility-text == "authpriv"
    and $syslogseverity-text == "info"
    and $msg contains "This is an Azure machine"
) then {
    stop
}

if (
    $msg contains "Certificate extension"
    and $msg contains "@sshservice.azure.net"
    and $msg contains "is not supported"
) then {
    stop
}

# --- Systemd audit con servicios/timers rutinarios
if ($msg startswith "type=SERVICE_START" and $msg contains "res=success" and ($msg contains "unit=sysstat-collect" or $msg contains "unit=fwupd-refresh" or $msg contains "unit=motd-news" or $msg contains "unit=apt-daily")) then stop

if ($msg startswith "type=SERVICE_STOP" and $msg contains "res=success" and ($msg contains "unit=sysstat-collect" or $msg contains "unit=fwupd-refresh" or $msg contains "unit=motd-news" or $msg contains "unit=apt-daily")) then stop

# --- Procesos rutinarios de cron ---
# Cron sin clave util
if ($msg contains 'comm="cron"' and $msg contains 'exe="/usr/sbin/cron"' and $msg contains "key=(null)") then stop
# PROCTITLE de cron en hexadecimal: /usr/sbin/CRON. Procesos rutinarios de cron
if ($msg startswith "type=PROCTITLE" and $msg contains "2F7573722F7362696E2F43524F4E") then stop

# --- Ruido PAM al utilizar sudo ---
# Ruido PAM sudo (instancias que abre/cierra en cada uso de `sudo`)
if ($syslogfacility-text == "authpriv" and $programname == "sudo" and $msg contains "pam_unix(sudo:session): session ") then stop

# --- Autenticación Azure ----
if ($msg contains "pam_aad" and $msg contains "This is an Azure machine") then stop
if ($programname == "aad_certhandler" and $msg startswith "Version:") then stop

# --- Instancias de usuario duplicadas de PAM sin info de login real ---
if ($msg contains "systemd-user:session") then stop
```

Verificamos que no haya problemas de sintaxis:
```bash
sudo rsyslogd -N1
```
Y reiniciamos el servicio para aplicar cambios:
```bash
sudo systemctl restart rsyslog
```

## Paso 4: Configurar AMA / DCR para recoger local6
Utilizaremos una **DCR** para definir qué logs se envían a nuestro *Log Analytic Workspace*. Al añadir la VM a la DCR, ya instalará automáticamente la extensión AMA para recoger los logs.

### Agregar recurso al DCR
![Screenshot de cómo agregar recurso a un DCR](/images/manejar-audit-logs-azure/agregar-recurso-dcr.png)

### Agregar origen de datos al DCR
![Screenshot de cómo agregar recurso a un DCR](/images/manejar-audit-logs-azure/agregar-origen-datos-dcr.png)
Dentro del origen de datos, debemos asegurarnos de añadir la **prioridad y *facility* a la que hemos enviado los logs** con audisp:
![Screenshot de LOCAL_INFO LOCAL6 checked](/images/manejar-audit-logs-azure/editar-origen-datos.png)
Por último, lo enviamos al *Log Workspace*:
![Screenshot del destino del DCR](/images/manejar-audit-logs-azure/enviar-dcr-a-log-workspace.png)


## Troubleshooting
En el caso de que aparentemente las configuraciones sean correctas tanto en DCR como *Log Workspace* pero siga sin funcionar, el problema puede ser del AMA. Para hacer *troubleshooting*, podemos utilizar el script `/var/lib/waagent/Microsoft.Azure.Monitor.AzureMonitorLinuxAgent-{version}/ama_tst/ama_troubleshooter.sh` para identificar el problema.

En mi caso, la instalación del demonio azuremonitoragent (AMA) no se había realizado correctamente. No tenía el fichero `/etc/rsyslog.d/10-azuremonitoragent-omfwd.conf`, aunque sí `/etc/opt/microsoft/azuremonitoragent/syslog/rsyslogconf/10-azuremonitoragent-omfwd.conf`.

Para solucionarlo, he utilizado el script `/var/lib/waagent/Microsoft.Azure.Monitor.AzureMonitorLinuxAgent-{version}/shim.sh` , que es el **wrapper de control del AMA** dentro de la extensión de Azure en la VM (AzureMonitorLinuxAgent). Al deshabilitarlo y habilitarlo, ha descargado configuración, reconstruido `config-cache`, entre otras funcionalidades.
```bash
./shim.sh  -disable
./shim.sh  -enable
systemctl restart rsyslog
systemctl restart azuremonitoragent
```

Referencias útiles:
- [Troubleshoot syslog issues with Azure Monitor Agent on Linux](https://learn.microsoft.com/en-us/azure/azure-monitor/agents/azure-monitor-agent-troubleshoot-linux-vm-rsyslog)
- [How to use the Linux operating system (OS) Azure Monitor Agent Troubleshooter](https://learn.microsoft.com/en-us/azure/azure-monitor/agents/troubleshooter-ama-linux)
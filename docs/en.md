# QNAP QSW

QNAP **QSW** managed switches (QSW-M408, QSW-M2116 and the other QSW-M models
running **QSS**) in Gladys, through the API of the local web interface of the
switch. Handy to watch the network of the house: a port that drops, a link
that falls back to 100 Mbit/s, a switch getting hot:

- the switch becomes a Gladys device (Discovery tab): **ports connected**,
  **temperature**, **fan 1** and **fan 2** speeds (rpm, when the switch has
  them), **receive** and **transmit rates** of all ports together,
  **uptime**, **firmware**; and for each port: **connected** (yes / no),
  **link speed** (0 when nothing is plugged in), **receive** and **transmit
  rates**;
- a **Reboot the switch** button, inactive until you allow it.

The rates are computed from the byte counters of two readings in a row (none
at the first reading, none when the counters start again, after a reboot of
the switch). The link aggregation groups (LACP) are not read, only the
physical ports. PoE is not read: the library this integration follows does not
read it, and its routes are not guessed. Unmanaged QSW switches have no
interface and cannot be read.

This is not the integration of the QNAP **NAS** (QTS, QuTS hero): that one is
another integration of the store.

> **This integration has never been tested with a real switch.** This first
> version follows aioqsw, the library Home Assistant uses, and was tested
> against a fake switch only. Tell on the Gladys forum what works and what
> does not, with the model and the QSS version.

Unofficial integration, not affiliated with QNAP.

## Before you start

1. The switch must be a **managed** QSW (with a web interface, QSS).
2. Gladys needs an administration account of the web interface (`admin` by
   default). Its password is kept by Gladys in its database, never shown
   again, and sent only to the switch.
3. Add one integration per switch.

## Settings

- **Address of the switch**: its IP address or host name, as you type it to
  open its interface. HTTPS by default (port 443, or `:port`). If your switch
  serves its interface in plain HTTP only, type `http://` before the address:
  the password (in base64, which anyone can read) then crosses your network
  readable by anyone on it.
- **User name**, **Password**.
- **Certificate fingerprint** (optional, HTTPS only): see below.
- **Refresh**: 30 s, 1 min (default), 2 or 5 min. The test button, a save of
  the form and a restart of Gladys or of the container do not read sooner
  (the time of the last attempt is kept, written before the reading). A press
  on **Reboot the switch** makes one fresh read of its own, outside the
  refresh.
- **Allow rebooting the switch**: off by default.

## The HTTPS certificate

The switch has a self-signed certificate, which no authority can vouch for.
Gladys checks it by its SHA-256 fingerprint, right after the TLS handshake
and **before** sending the password:

- the field empty, at the first connection: Gladys writes the certificate
  met to its storage, **then** sends the password. If its storage cannot be
  read or written, nothing is learned and nothing is sent (the status shows
  the fingerprint met; the storage is read again every 10 s);
- afterwards, another certificate stops everything (nothing is sent) and
  the status shows its fingerprint. Saving the form again changes nothing.
  If you replaced or reset the switch, type in **Certificate fingerprint**
  the fingerprint your browser shows for it (padlock, certificate, SHA-256):
  it becomes the trusted one.

## The reboot

The **Reboot the switch** button is a button, never a switch: a "turn
everything off" of a voice assistant or a scene never reaches it. Every
device plugged into the switch loses its network for 1 to 3 minutes. A press
is refused, nothing sent, in these cases:

- **Allow rebooting the switch** is off (checked again right before the
  request is written);
- the configuration is incomplete, the login or the certificate was refused,
  another switch answers at the address, or Gladys is in a pause asked by the
  switch (HTTP 429 or 5xx);
- a reboot was sent less than 10 minutes ago (kept across restarts), or this
  delay cannot be written to the storage of the integration (/data), or that
  storage cannot be read;
- a reboot is already being sent, or a reading in progress does not end
  within 2.5 s of the press;
- the switch does not answer the read made just before within 2.5 s, or
  another switch answers (another MAC), or its MAC cannot be read or was
  never read before at this address;
- the request could not be written within 3.5 s of the press.

A press does not wait for the readings to come back after an outage: its own
fresh read decides. When the request was written but the switch did not
answer, Gladys says "sent, without an answer": the switch may be rebooting.
For 5 minutes, a reading that fails says the switch is rebooting.

## Failures

- **Credentials refused** (by the login page of the switch only): nothing is
  sent again until the user name or the password is saved again in the form
  (the password saved is then tried once, even the same one); the **Test the
  connection** button tries once more. Gladys keeps an 8-bit marker of the
  refused password (shared by 1 password in 256, never the password) so that
  a restart does not try it again.
- **HTTP 429 or 5xx** on the board or the port status: a pause of every
  request (1 min to 6 h), kept across restarts. The other routes (rates,
  sensors, uptime, firmware) never pause nor stop the reading (a refused
  certificate or login aside, which stops everything wherever it is met):
  what they did not give this time is said in the status.
- **No answer**: tried again after 1 minute or the refresh interval if
  longer, then twice as long each time, up to 30 minutes.
- **Another switch** at the address (another MAC): nothing is published nor
  sent; save the form to take it as the new one.

Neither the password, nor the session token, nor the MAC address or the
serial number are logged or published. The storage keeps the certificate
fingerprint, the 8-bit marker above, and a salted hash of the MAC of the
switch (not the MAC in clear).

## Not done (yet)

PoE (power per port), the link aggregation groups, the error counters, the
firmware update check: say on the forum if you need one.

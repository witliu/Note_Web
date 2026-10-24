"""Run with --lan to share this host's database on the local network."""
import argparse
import ipaddress
import os
import socket

import uvicorn


def lan_addresses():
    addresses = set()
    try:
        for item in socket.getaddrinfo(socket.gethostname(), None, family=socket.AF_INET):
            address = ipaddress.ip_address(item[4][0])
            if address.is_private and not address.is_loopback and not address.is_link_local:
                addresses.add(str(address))
    except OSError:
        pass
    return sorted(addresses)


def main():
    parser = argparse.ArgumentParser(description='Couple journal development server')
    parser.add_argument('--lan', action='store_true', help='Share with devices on the local network')
    parser.add_argument('--port', type=int, default=8000)
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error('port must be between 1 and 65535')
    host = '0.0.0.0' if args.lan else '127.0.0.1'
    addresses = lan_addresses() if args.lan else []
    if args.lan and not addresses:
        parser.error('No private IPv4 address found. Connect to your LAN and try again.')
    configured = os.environ.get('JOURNAL_ALLOWED_HOSTS', '')
    os.environ['JOURNAL_ALLOWED_HOSTS'] = ','.join(filter(None, [configured, *addresses]))
    print(f'Local: http://127.0.0.1:{args.port}/', flush=True)
    for address in addresses:
        print(f'LAN:   http://{address}:{args.port}/', flush=True)
    if args.lan:
        print('LAN trial: no account sign-in yet. Devices on this LAN can read and edit.', flush=True)
        print('Keep this computer awake. Do not forward this port to the internet.', flush=True)
    uvicorn.run('backend.app:app', host=host, port=args.port)


if __name__ == '__main__':
    main()

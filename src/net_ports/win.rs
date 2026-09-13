use super::ConnEntry;
use std::collections::BTreeSet;
use std::net::{Ipv4Addr, Ipv6Addr};
use windows::Win32::NetworkManagement::IpHelper::{
    GetExtendedTcpTable, GetExtendedUdpTable, MIB_TCP6ROW_OWNER_PID, MIB_TCPROW_OWNER_PID,
    MIB_UDP6ROW_OWNER_PID, MIB_UDPROW_OWNER_PID, TCP_TABLE_OWNER_PID_ALL, UDP_TABLE_OWNER_PID,
};
use windows::Win32::Networking::WinSock::{AF_INET, AF_INET6};

const ERROR_INSUFFICIENT_BUFFER: u32 = 122;

pub fn snapshot_all() -> Result<Vec<ConnEntry>, String> {
    let mut set = BTreeSet::new();
    for row in query_tcp_v4()? {
        set.insert(row);
    }
    for row in query_tcp_v6()? {
        set.insert(row);
    }
    for row in query_udp_v4()? {
        set.insert(row);
    }
    for row in query_udp_v6()? {
        set.insert(row);
    }
    Ok(set.into_iter().collect())
}

fn win_port(raw: u32) -> u16 {
    let lo = (raw & 0xFF) as u16;
    let hi = ((raw >> 8) & 0xFF) as u16;
    lo << 8 | hi
}

fn ipv4_addr(raw: u32) -> String {
    Ipv4Addr::from(raw.to_le_bytes()).to_string()
}

fn ipv6_addr(bytes: &[u8; 16]) -> String {
    Ipv6Addr::from(*bytes).to_string()
}

fn tcp_state_name(state: u32) -> &'static str {
    match state {
        1 => "CLOSED",
        2 => "LISTEN",
        3 => "SYN_SENT",
        4 => "SYN_RCVD",
        5 => "ESTAB",
        6 => "FIN_WAIT1",
        7 => "FIN_WAIT2",
        8 => "CLOSE_WAIT",
        9 => "CLOSING",
        10 => "LAST_ACK",
        11 => "TIME_WAIT",
        12 => "DELETE_TCB",
        _ => "UNK",
    }
}

fn query_tcp_v4() -> Result<Vec<ConnEntry>, String> {
    let family = AF_INET.0 as u32;
    let mut size: u32 = 0;
    let err = unsafe {
        GetExtendedTcpTable(
            None,
            &mut size,
            false,
            family,
            TCP_TABLE_OWNER_PID_ALL,
            0,
        )
    };
    if err != 0 && err != ERROR_INSUFFICIENT_BUFFER {
        return Err(format!("GetExtendedTcpTable(v4) size: {err}"));
    }
    if size == 0 {
        return Ok(Vec::new());
    }
    let mut buf = vec![0u8; size as usize];
    let err = unsafe {
        GetExtendedTcpTable(
            Some(buf.as_mut_ptr() as *mut _),
            &mut size,
            false,
            family,
            TCP_TABLE_OWNER_PID_ALL,
            0,
        )
    };
    if err != 0 {
        return Err(format!("GetExtendedTcpTable(v4): {err}"));
    }
    parse_tcp_v4(&buf)
}

fn parse_tcp_v4(buf: &[u8]) -> Result<Vec<ConnEntry>, String> {
    if buf.len() < 4 {
        return Ok(Vec::new());
    }
    let count = u32::from_le_bytes(buf[0..4].try_into().unwrap()) as usize;
    let row_size = std::mem::size_of::<MIB_TCPROW_OWNER_PID>();
    let need = 4 + count * row_size;
    if buf.len() < need {
        return Err("GetExtendedTcpTable(v4) 缓冲区长度不足".into());
    }
    let mut out = Vec::with_capacity(count);
    unsafe {
        let base = buf.as_ptr().add(4) as *const MIB_TCPROW_OWNER_PID;
        for i in 0..count {
            let row = &*base.add(i);
            let local = format!("{}:{}", ipv4_addr(row.dwLocalAddr), win_port(row.dwLocalPort));
            let remote = format!("{}:{}", ipv4_addr(row.dwRemoteAddr), win_port(row.dwRemotePort));
            out.push(ConnEntry {
                proto: "tcp",
                local,
                remote,
                state: tcp_state_name(row.dwState),
                pid: row.dwOwningPid,
            });
        }
    }
    Ok(out)
}

fn query_tcp_v6() -> Result<Vec<ConnEntry>, String> {
    let family = AF_INET6.0 as u32;
    let mut size: u32 = 0;
    let err = unsafe {
        GetExtendedTcpTable(
            None,
            &mut size,
            false,
            family,
            TCP_TABLE_OWNER_PID_ALL,
            0,
        )
    };
    if err != 0 && err != ERROR_INSUFFICIENT_BUFFER {
        return Err(format!("GetExtendedTcpTable(v6) size: {err}"));
    }
    if size == 0 {
        return Ok(Vec::new());
    }
    let mut buf = vec![0u8; size as usize];
    let err = unsafe {
        GetExtendedTcpTable(
            Some(buf.as_mut_ptr() as *mut _),
            &mut size,
            false,
            family,
            TCP_TABLE_OWNER_PID_ALL,
            0,
        )
    };
    if err != 0 {
        return Err(format!("GetExtendedTcpTable(v6): {err}"));
    }
    parse_tcp_v6(&buf)
}

fn parse_tcp_v6(buf: &[u8]) -> Result<Vec<ConnEntry>, String> {
    if buf.len() < 4 {
        return Ok(Vec::new());
    }
    let count = u32::from_le_bytes(buf[0..4].try_into().unwrap()) as usize;
    let row_size = std::mem::size_of::<MIB_TCP6ROW_OWNER_PID>();
    let need = 4 + count * row_size;
    if buf.len() < need {
        return Err("GetExtendedTcpTable(v6) 缓冲区长度不足".into());
    }
    let mut out = Vec::with_capacity(count);
    unsafe {
        let base = buf.as_ptr().add(4) as *const MIB_TCP6ROW_OWNER_PID;
        for i in 0..count {
            let row = &*base.add(i);
            let local = format!(
                "[{}]:{}",
                ipv6_addr(&row.ucLocalAddr),
                win_port(row.dwLocalPort)
            );
            let remote = format!(
                "[{}]:{}",
                ipv6_addr(&row.ucRemoteAddr),
                win_port(row.dwRemotePort)
            );
            out.push(ConnEntry {
                proto: "tcp",
                local,
                remote,
                state: tcp_state_name(row.dwState),
                pid: row.dwOwningPid,
            });
        }
    }
    Ok(out)
}

fn query_udp_v4() -> Result<Vec<ConnEntry>, String> {
    let family = AF_INET.0 as u32;
    let mut size: u32 = 0;
    let err = unsafe {
        GetExtendedUdpTable(
            None,
            &mut size,
            false,
            family,
            UDP_TABLE_OWNER_PID,
            0,
        )
    };
    if err != 0 && err != ERROR_INSUFFICIENT_BUFFER {
        return Err(format!("GetExtendedUdpTable(v4) size: {err}"));
    }
    if size == 0 {
        return Ok(Vec::new());
    }
    let mut buf = vec![0u8; size as usize];
    let err = unsafe {
        GetExtendedUdpTable(
            Some(buf.as_mut_ptr() as *mut _),
            &mut size,
            false,
            family,
            UDP_TABLE_OWNER_PID,
            0,
        )
    };
    if err != 0 {
        return Err(format!("GetExtendedUdpTable(v4): {err}"));
    }
    parse_udp_v4(&buf)
}

fn parse_udp_v4(buf: &[u8]) -> Result<Vec<ConnEntry>, String> {
    if buf.len() < 4 {
        return Ok(Vec::new());
    }
    let count = u32::from_le_bytes(buf[0..4].try_into().unwrap()) as usize;
    let row_size = std::mem::size_of::<MIB_UDPROW_OWNER_PID>();
    let need = 4 + count * row_size;
    if buf.len() < need {
        return Err("GetExtendedUdpTable(v4) 缓冲区长度不足".into());
    }
    let mut out = Vec::with_capacity(count);
    unsafe {
        let base = buf.as_ptr().add(4) as *const MIB_UDPROW_OWNER_PID;
        for i in 0..count {
            let row = &*base.add(i);
            let local = format!("{}:{}", ipv4_addr(row.dwLocalAddr), win_port(row.dwLocalPort));
            out.push(ConnEntry {
                proto: "udp",
                local,
                remote: String::new(),
                state: "",
                pid: row.dwOwningPid,
            });
        }
    }
    Ok(out)
}

fn query_udp_v6() -> Result<Vec<ConnEntry>, String> {
    let family = AF_INET6.0 as u32;
    let mut size: u32 = 0;
    let err = unsafe {
        GetExtendedUdpTable(
            None,
            &mut size,
            false,
            family,
            UDP_TABLE_OWNER_PID,
            0,
        )
    };
    if err != 0 && err != ERROR_INSUFFICIENT_BUFFER {
        return Err(format!("GetExtendedUdpTable(v6) size: {err}"));
    }
    if size == 0 {
        return Ok(Vec::new());
    }
    let mut buf = vec![0u8; size as usize];
    let err = unsafe {
        GetExtendedUdpTable(
            Some(buf.as_mut_ptr() as *mut _),
            &mut size,
            false,
            family,
            UDP_TABLE_OWNER_PID,
            0,
        )
    };
    if err != 0 {
        return Err(format!("GetExtendedUdpTable(v6): {err}"));
    }
    parse_udp_v6(&buf)
}

fn parse_udp_v6(buf: &[u8]) -> Result<Vec<ConnEntry>, String> {
    if buf.len() < 4 {
        return Ok(Vec::new());
    }
    let count = u32::from_le_bytes(buf[0..4].try_into().unwrap()) as usize;
    let row_size = std::mem::size_of::<MIB_UDP6ROW_OWNER_PID>();
    let need = 4 + count * row_size;
    if buf.len() < need {
        return Err("GetExtendedUdpTable(v6) 缓冲区长度不足".into());
    }
    let mut out = Vec::with_capacity(count);
    unsafe {
        let base = buf.as_ptr().add(4) as *const MIB_UDP6ROW_OWNER_PID;
        for i in 0..count {
            let row = &*base.add(i);
            let local = format!(
                "[{}]:{}",
                ipv6_addr(&row.ucLocalAddr),
                win_port(row.dwLocalPort)
            );
            out.push(ConnEntry {
                proto: "udp",
                local,
                remote: String::new(),
                state: "",
                pid: row.dwOwningPid,
            });
        }
    }
    Ok(out)
}

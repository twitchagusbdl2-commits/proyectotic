const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Configuración de la base de datos PostgreSQL
const pool = new Pool({
    user: 'postgres',
    host: 'localhost',
    database: 'proyectotic',
    password: 'agusbdl3', // Cambia por tu contraseña
    port: 5432,
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'))); // Servir archivos estáticos

// Verificar conexión a la base de datos
pool.connect((err, client, release) => {
    if (err) {
        console.error('Error conectando a la base de datos:', err);
    } else {
        console.log('Conectado a PostgreSQL exitosamente');
        release();
    }
});

// RUTAS API

// 1. OBTENER ACTIVIDADES
app.get('/api/actividades', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT id, nombre, descripcion, duracion_minutos, cupo_maximo, precio_mensual 
            FROM actividades 
            WHERE estado = 'activa'
            ORDER BY nombre
        `);
        res.json(result.rows);
    } catch (err) {
        console.error('Error obteniendo actividades:', err);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// 2. OBTENER HORARIOS DISPONIBLES PARA UNA FECHA
app.get('/api/horarios/:fecha', async (req, res) => {
    try {
        const { fecha } = req.params;
        const result = await pool.query(`
            SELECT 
                cp.id,
                a.nombre as actividad_nombre,
                a.id as actividad_id,
                cp.fecha,
                cp.hora_inicio,
                cp.hora_fin,
                cp.cupo_disponible,
                a.duracion_minutos,
                CONCAT(i.nombre, ' ', i.apellido) as instructor
            FROM clases_programadas cp
            JOIN horarios_base hb ON cp.horario_base_id = hb.id
            JOIN actividades a ON hb.actividad_id = a.id
            LEFT JOIN instructores i ON cp.instructor_id = i.id
            WHERE cp.fecha = $1 
                AND cp.estado = 'programada' 
                AND cp.cupo_disponible > 0
                AND a.estado = 'activa'
            ORDER BY cp.hora_inicio, a.nombre
        `, [fecha]);
        
        res.json(result.rows);
    } catch (err) {
        console.error('Error obteniendo horarios:', err);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// 3. CREAR/VERIFICAR CLIENTE
app.post('/api/clientes', async (req, res) => {
    try {
        const { nombre, email, telefono } = req.body;
        
        // Verificar si el cliente ya existe
        let result = await pool.query('SELECT id FROM clientes WHERE email = $1', [email]);
        
        if (result.rows.length > 0) {
            // Cliente existe, devolver su ID
            res.json({ id: result.rows[0].id, exists: true });
        } else {
            // Crear nuevo cliente
            result = await pool.query(`
                INSERT INTO clientes (nombre, email, telefono) 
                VALUES ($1, $2, $3) 
                RETURNING id
            `, [nombre, email, telefono]);
            
            res.json({ id: result.rows[0].id, exists: false });
        }
    } catch (err) {
        console.error('Error con cliente:', err);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// 4. CREAR RESERVA
app.post('/api/reservas', async (req, res) => {
    const client = await pool.connect();
    
    try {
        await client.query('BEGIN');
        
        const { cliente_id, clase_programada_id } = req.body;
        
        // Verificar que la clase tenga cupo disponible
        const claseResult = await client.query(`
            SELECT cupo_disponible FROM clases_programadas 
            WHERE id = $1 AND estado = 'programada'
        `, [clase_programada_id]);
        
        if (claseResult.rows.length === 0) {
            throw new Error('Clase no encontrada o no disponible');
        }
        
        if (claseResult.rows[0].cupo_disponible <= 0) {
            throw new Error('No hay cupo disponible para esta clase');
        }
        
        // Verificar que el cliente no tenga ya una reserva para esta clase
        const reservaExistente = await client.query(`
            SELECT id FROM reservas 
            WHERE cliente_id = $1 AND clase_programada_id = $2 AND estado != 'cancelada'
        `, [cliente_id, clase_programada_id]);
        
        if (reservaExistente.rows.length > 0) {
            throw new Error('Ya tienes una reserva para esta clase');
        }
        
        // Crear la reserva
        const reservaResult = await client.query(`
            INSERT INTO reservas (cliente_id, clase_programada_id) 
            VALUES ($1, $2) 
            RETURNING id, fecha_reserva
        `, [cliente_id, clase_programada_id]);
        
        await client.query('COMMIT');
        
        res.json({
            id: reservaResult.rows[0].id,
            fecha_reserva: reservaResult.rows[0].fecha_reserva,
            success: true
        });
        
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Error creando reserva:', err);
        res.status(400).json({ error: err.message });
    } finally {
        client.release();
    }
});

// 5. OBTENER RESERVAS
app.get('/api/reservas', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                r.id,
                c.nombre as cliente_nombre,
                c.email,
                c.telefono,
                a.nombre as actividad_nombre,
                cp.fecha,
                cp.hora_inicio,
                cp.hora_fin,
                r.estado,
                r.fecha_reserva
            FROM reservas r
            JOIN clientes c ON r.cliente_id = c.id
            JOIN clases_programadas cp ON r.clase_programada_id = cp.id
            JOIN horarios_base hb ON cp.horario_base_id = hb.id
            JOIN actividades a ON hb.actividad_id = a.id
            WHERE r.estado = 'confirmada'
            ORDER BY cp.fecha DESC, cp.hora_inicio DESC
        `);
        
        res.json(result.rows);
    } catch (err) {
        console.error('Error obteniendo reservas:', err);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// 6. GUARDAR CÁLCULO FITNESS
app.post('/api/calculos', async (req, res) => {
    try {
        const { cliente_id, tipo_calculo, parametros, resultados } = req.body;
        
        const result = await pool.query(`
            INSERT INTO calculos_fitness (cliente_id, tipo_calculo, parametros, resultados) 
            VALUES ($1, $2, $3, $4) 
            RETURNING id, fecha_calculo
        `, [cliente_id, tipo_calculo, JSON.stringify(parametros), JSON.stringify(resultados)]);
        
        res.json({
            id: result.rows[0].id,
            fecha_calculo: result.rows[0].fecha_calculo,
            success: true
        });
        
    } catch (err) {
        console.error('Error guardando cálculo:', err);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// 7. GENERAR CLASES PARA UNA SEMANA
app.post('/api/generar-clases', async (req, res) => {
    try {
        const { fecha_inicio, fecha_fin } = req.body;
        
        const result = await pool.query(`
            SELECT generar_clases_semanales($1, $2) as clases_generadas
        `, [fecha_inicio, fecha_fin]);
        
        res.json({
            clases_generadas: result.rows[0].clases_generadas,
            success: true
        });
        
    } catch (err) {
        console.error('Error generando clases:', err);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// 8. OBTENER CONFIGURACIÓN
app.get('/api/configuracion', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT clave, valor FROM configuracion
        `);
        
        const config = {};
        result.rows.forEach(row => {
            config[row.clave] = row.valor;
        });
        
        res.json(config);
    } catch (err) {
        console.error('Error obteniendo configuración:', err);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// 9. OBTENER ESTADÍSTICAS DEL DASHBOARD
app.get('/api/estadisticas', async (req, res) => {
    try {
        // Total de clientes activos
        const clientesResult = await pool.query(`
            SELECT COUNT(*) as total FROM clientes WHERE estado = 'activo'
        `);
        
        // Reservas de hoy
        const reservasHoyResult = await pool.query(`
            SELECT COUNT(*) as total FROM reservas r
            JOIN clases_programadas cp ON r.clase_programada_id = cp.id
            WHERE cp.fecha = CURRENT_DATE AND r.estado = 'confirmada'
        `);
        
        // Actividad más popular
        const actividadPopularResult = await pool.query(`
            SELECT a.nombre, COUNT(r.id) as total_reservas
            FROM actividades a
            LEFT JOIN horarios_base hb ON a.id = hb.actividad_id
            LEFT JOIN clases_programadas cp ON hb.id = cp.horario_base_id
            LEFT JOIN reservas r ON cp.id = r.clase_programada_id
            WHERE r.estado = 'confirmada'
            GROUP BY a.id, a.nombre
            ORDER BY total_reservas DESC
            LIMIT 1
        `);
        
        // Ingresos del mes (estimado)
        const ingresosResult = await pool.query(`
            SELECT SUM(a.precio_mensual) as ingresos_estimados
            FROM suscripciones s
            JOIN membresias m ON s.membresia_id = m.id
            JOIN actividades a ON true  -- Simplificado
            WHERE s.estado = 'activa'
                AND s.fecha_inicio <= CURRENT_DATE
                AND s.fecha_fin >= CURRENT_DATE
        `);
        
        res.json({
            total_clientes: parseInt(clientesResult.rows[0].total),
            reservas_hoy: parseInt(reservasHoyResult.rows[0].total),
            actividad_popular: actividadPopularResult.rows[0]?.nombre || 'N/A',
            ingresos_estimados: parseFloat(ingresosResult.rows[0]?.ingresos_estimados || 0)
        });
        
    } catch (err) {
        console.error('Error obteniendo estadísticas:', err);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// SERVIR EL HTML PRINCIPAL
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// INICIALIZACIÓN DEL SERVIDOR
app.listen(PORT, async () => {
    console.log(`Servidor FitZone ejecutándose en http://localhost:${PORT}`);
    
    // Generar clases para la próxima semana al iniciar el servidor
    try {
        const hoy = new Date();
        const proximaSemana = new Date(hoy.getTime() + 7 * 24 * 60 * 60 * 1000);
        
        await pool.query(`
            SELECT generar_clases_semanales($1, $2)
        `, [hoy.toISOString().split('T')[0], proximaSemana.toISOString().split('T')[0]]);
        
        console.log('Clases generadas para la próxima semana');
    } catch (err) {
        console.error('Error generando clases iniciales:', err);
    }
});

// Manejo de errores global
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ error: 'Algo salió mal!' });
});

// Ruta 404
app.use('*', (req, res) => {
    res.status(404).json({ error: 'Ruta no encontrada' });
});

module.exports = app;